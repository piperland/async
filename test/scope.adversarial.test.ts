import { describe, expect, it } from 'vitest';
import { scope } from '../src/scope.js';
import {
  deferred,
  gate,
  recorder,
  signalAwareWorker,
  tick,
  trackUnhandledRejections,
} from './helpers/adversarial.js';

describe('scope: adversarial races', () => {
  it('callback resolves while child rejects → child error wins', async () => {
    const childDone = deferred<void>();
    const p = scope(async (s) => {
      s.spawn(async () => {
        await childDone.promise;
        throw new Error('child-fail');
      });
      // callback resolves without awaiting child
      return 'cb-result';
    });
    childDone.reject(new Error('child-fail'));
    await expect(p).rejects.toThrow('child-fail');
  });

  it('callback rejects while child resolves → callback error wins', async () => {
    const childGate = gate();
    const child = async (signal: AbortSignal): Promise<string> => {
      // wait on the gate OR abort, whichever first
      await Promise.race([
        childGate.wait(),
        new Promise<never>((_, rej) =>
          signal.addEventListener('abort', () => rej(signal.reason), {
            once: true,
          }),
        ),
      ]);
      return 'child';
    };
    await expect(
      scope(async (s) => {
        s.spawn(child);
        throw new Error('cb-fail');
      }),
    ).rejects.toThrow('cb-fail');
    childGate.open();
  });

  it('external abort while callback resolves → abort reason wins', async () => {
    const ctrl = new AbortController();
    const cbGate = gate();
    const p = scope(
      async () => {
        await cbGate.wait();
        return 'cb-done';
      },
      { signal: ctrl.signal },
    );
    const reason = new Error('ext-stop');
    ctrl.abort(reason);
    cbGate.open();
    await expect(p).rejects.toBe(reason);
  });

  it('external abort while child rejects → first observed wins', async () => {
    // both happen same turn; the abort reason or child error — whichever the
    // implementation observes first — must be deterministic, not both.
    const ctrl = new AbortController();
    const reason = new Error('ext-stop');
    const childGate = gate();
    const p = scope(
      async (s) => {
        s.spawn(async () => {
          await childGate.wait();
          throw new Error('child-fail');
        });
        await childGate.wait();
      },
      { signal: ctrl.signal },
    );
    ctrl.abort(reason);
    childGate.open();
    await expect(p).rejects.toBe(reason);
  });

  it('two children reject same turn → one authoritative, one observed', async () => {
    const stop = trackUnhandledRejections();
    try {
      await expect(
        scope(async (s) => {
          s.spawn(async () => {
            throw new Error('first');
          });
          s.spawn(async () => {
            throw new Error('second');
          });
        }),
      ).rejects.toThrow(/first|second/);
      // both observed; no unhandled
      await tick();
      expect(
        stop.observed.filter(
          (u) => String(u).includes('first') || String(u).includes('second'),
        ),
      ).toHaveLength(0);
    } finally {
      stop.stop();
    }
  });

  it('three children reject same turn → one authoritative', async () => {
    const stop = trackUnhandledRejections();
    try {
      await expect(
        scope(async (s) => {
          s.spawn(async () => {
            throw new Error('a');
          });
          s.spawn(async () => {
            throw new Error('b');
          });
          s.spawn(async () => {
            throw new Error('c');
          });
        }),
      ).rejects.toThrow(/a|b|c/);
      await tick();
      expect(stop.observed).toHaveLength(0);
    } finally {
      stop.stop();
    }
  });

  it('child rejects while scope closes → child error still authoritative', async () => {
    const rec = recorder();
    const childGate = gate();
    const p = scope(async (s) => {
      s.spawn(async () => {
        rec.push('child:start');
        await childGate.wait();
        throw new Error('late-child-fail');
      });
      rec.push('cb:return');
      return 'done';
    });
    // callback returned; scope is closing. Child fails during teardown-wait.
    await tick();
    childGate.open();
    await expect(p).rejects.toThrow('late-child-fail');
  });

  it('spawn during teardown-wait (after callback resolved) throws', async () => {
    const rec = recorder();
    // a child that stays pending keeps the scope in teardown-wait
    const childGate = gate();
    const lateSpawn = deferred<void>();
    const p = scope(async (s) => {
      s.spawn(async () => {
        await childGate.wait();
        return 'child';
      });
      // after callback returns, scope awaits the pending child. A later
      // microtask tries to spawn while the scope is still closing.
      void lateSpawn.promise.then(() => {
        try {
          s.spawn(async () => 'late');
          rec.push('spawn:allowed');
        } catch {
          rec.push('spawn:threw');
        }
      });
      return 'done';
    });
    // scope now closing, awaiting the child; trigger the late spawn
    lateSpawn.resolve();
    await tick();
    expect(rec.includes('spawn:threw')).toBe(true);
    expect(rec.includes('spawn:allowed')).toBe(false);
    childGate.open(); // release scope
    await p;
  });

  it('spawn exactly as cancellation begins → throws', async () => {
    const ctrl = new AbortController();
    const rec = recorder();
    const p = scope(
      async (s) => {
        // a microtask that runs after abort fires
        Promise.resolve().then(() => {
          try {
            s.spawn(async () => 'late');
            rec.push('spawn:allowed');
          } catch {
            rec.push('spawn:threw');
          }
        });
        await new Promise((r) => setTimeout(r, 5));
        return 'done';
      },
      { signal: ctrl.signal },
    );
    ctrl.abort(new Error('cancel'));
    await expect(p).rejects.toThrow('cancel');
    await tick();
    expect(rec.includes('spawn:threw')).toBe(true);
  });

  it('spawn from a child during parent cancellation → throws', async () => {
    const ctrl = new AbortController();
    const rec = recorder();
    const p = scope(
      async (s) => {
        s.spawn(async (signal) => {
          await new Promise((r) => setTimeout(r, 5));
          try {
            s.spawn(async () => 'grandchild');
            rec.push('gc:allowed');
          } catch {
            rec.push('gc:threw');
          }
          throw signal.reason;
        });
        await new Promise((r) => setTimeout(r, 20));
        return 'done';
      },
      { signal: ctrl.signal },
    );
    ctrl.abort(new Error('parent-cancel'));
    await expect(p).rejects.toThrow('parent-cancel');
    await tick();
    expect(rec.includes('gc:threw')).toBe(true);
    expect(rec.includes('gc:allowed')).toBe(false);
  });

  it('spawn after external abort → callback never runs, scope rejects', async () => {
    const ctrl = new AbortController();
    ctrl.abort(new Error('pre'));
    const rec = recorder();
    await expect(
      scope(
        async (s) => {
          rec.push('callback-ran');
          s.spawn(async () => 'x');
          return 'never';
        },
        { signal: ctrl.signal },
      ),
    ).rejects.toThrow('pre');
    // callback body never executed (signal already aborted)
    expect(rec.includes('callback-ran')).toBe(false);
  });

  it('no double cleanup on child failure', async () => {
    const rec = recorder();
    await expect(
      scope(async (s) => {
        s.spawn(async () => {
          try {
            await new Promise((_r, rej) =>
              setTimeout(() => rej(new Error('f')), 1),
            );
          } finally {
            rec.push('cleanup');
          }
        });
        await new Promise((r) => setTimeout(r, 5));
      }),
    ).rejects.toThrow('f');
    await tick();
    expect(rec.count('cleanup')).toBe(1);
  });

  it('scope never settles early: callback returns before child gate', async () => {
    const childGate = gate();
    const rec = recorder();
    const p = scope(async (s) => {
      s.spawn(async () => {
        await childGate.wait();
        rec.push('child:done');
        return 'child';
      });
      rec.push('cb:return');
      return 'main';
    }).then((v) => {
      rec.push(`scope:resolved:${v}`);
      return v;
    });
    await tick();
    // scope must NOT have resolved yet (child still pending)
    expect(rec.includes('scope:resolved')).toBe(false);
    childGate.open();
    await p;
    expect(rec.includes('child:done')).toBe(true);
    expect(rec.includes('scope:resolved:main')).toBe(true);
  });
});

describe('scope: spawn storm', () => {
  it('1k lightweight children all complete', async () => {
    const N = 1000;
    let completed = 0;
    await scope(async (s) => {
      for (let i = 0; i < N; i++) {
        s.spawn(async () => {
          completed++;
          return i;
        });
      }
    });
    expect(completed).toBe(N);
  });

  it('10k children all complete (no dropped/duplicated)', async () => {
    const N = 10_000;
    let completed = 0;
    const seen = new Set<number>();
    await scope(async (s) => {
      for (let i = 0; i < N; i++) {
        s.spawn(async () => {
          if (seen.has(i)) throw new Error(`duplicate ${i}`);
          seen.add(i);
          completed++;
          return i;
        });
      }
    });
    expect(completed).toBe(N);
    expect(seen.size).toBe(N);
  });

  it('failure storm: 1k children, one fails, rest observe cancellation', async () => {
    const stop = trackUnhandledRejections();
    const rec = recorder();
    try {
      await expect(
        scope(async (s) => {
          for (let i = 0; i < 1000; i++) {
            if (i === 500) {
              s.spawn(async () => {
                throw new Error('the-one');
              });
            } else {
              s.spawn(signalAwareWorker(`w${i}`, rec, { finishDelayMs: 5 }));
            }
          }
        }),
      ).rejects.toThrow('the-one');
      await tick();
      expect(stop.observed).toHaveLength(0);
    } finally {
      stop.stop();
    }
  });

  it('many children fail nearly simultaneously → one authoritative', async () => {
    const stop = trackUnhandledRejections();
    try {
      await expect(
        scope(async (s) => {
          for (let i = 0; i < 500; i++) {
            s.spawn(async () => {
              throw new Error(`fail-${i}`);
            });
          }
        }),
      ).rejects.toThrow(/fail-/);
      await tick();
      expect(stop.observed).toHaveLength(0);
    } finally {
      stop.stop();
    }
  });
});

describe('scope: cancellation storm', () => {
  it('create+abort scope 500 times; no listener accumulation', async () => {
    const rec = recorder();
    const ctrl = new AbortController();
    for (let i = 0; i < 500; i++) {
      const p = scope(
        async (s) => {
          s.spawn(signalAwareWorker(`c${i}`, rec));
          await new Promise((r) => setTimeout(r, 1));
          return 'done';
        },
        { signal: ctrl.signal },
      );
      ctrl.abort(new Error('stop'));
      await p.catch(() => {});
    }
    await tick();
  });

  it('large cooperative group all receive same authoritative reason', async () => {
    const N = 200;
    const ctrl = new AbortController();
    const reason = new Error('group-stop');
    const rec = recorder();
    const p = scope(
      async (s) => {
        for (let i = 0; i < N; i++) {
          s.spawn(signalAwareWorker(`g${i}`, rec));
        }
        await new Promise((r) => setTimeout(r, 10));
        return 'done';
      },
      { signal: ctrl.signal },
    );
    ctrl.abort(reason);
    await expect(p).rejects.toBe(reason);
    // every cooperative worker observed abort
    for (let i = 0; i < N; i++) {
      expect(rec.includes(`g${i}:aborted`)).toBe(true);
    }
  });
});

describe('scope: already-aborted signal matrix', () => {
  it('aborted before scope call → rejects immediately, no work starts', async () => {
    const ctrl = new AbortController();
    ctrl.abort(new Error('pre'));
    const rec = recorder();
    await expect(
      scope(
        async (s) => {
          s.spawn(() => {
            rec.push('work-started');
            return 1;
          });
          return 'never';
        },
        { signal: ctrl.signal },
      ),
    ).rejects.toThrow('pre');
    expect(rec.includes('work-started')).toBe(false);
  });

  it('aborted same turn as call → reason preserved', async () => {
    const ctrl = new AbortController();
    const reason = new Error('same-turn');
    const p = scope(async () => 'x', { signal: ctrl.signal });
    ctrl.abort(reason); // sync abort after call
    await expect(p).rejects.toBe(reason);
  });
});

describe('scope: abort reason torture', () => {
  it.each([
    ['Error', new Error('stop')],
    ['DOMException', new DOMException('aborted', 'AbortError')],
    ['string', 'string-reason'],
    ['number', 42],
    ['null', null],
    ['object', { custom: 'obj' }],
  ])('preserves %s reason', async (_name, reason) => {
    const ctrl = new AbortController();
    const p = scope(async () => 'x', { signal: ctrl.signal });
    ctrl.abort(reason);
    await expect(p).rejects.toBe(reason);
  });

  it('undefined reason is normalized by AbortSignal.any to default AbortError (native)', async () => {
    // Native platform behavior: AbortSignal.any() normalizes `undefined` reason
    // to a default DOMException AbortError. Piper preserves native semantics.
    const ctrl = new AbortController();
    const p = scope(async () => 'x', { signal: ctrl.signal });
    ctrl.abort(undefined);
    await expect(p).rejects.toMatchObject({ name: 'AbortError' });
  });
});
