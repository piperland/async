import { describe, expect, it } from 'vitest';
import { scope } from '../src/scope.js';

// Instrument unhandled rejections so tests prove none escape.
const unhandled: unknown[] = [];
function trackUnhandled() {
  const handler = (reason: unknown) => {
    unhandled.push(reason);
  };
  process.on('unhandledRejection', handler);
  return () => process.off('unhandledRejection', handler);
}

describe('scope', () => {
  it('empty scope resolves', async () => {
    await expect(scope(async () => undefined)).resolves.toBeUndefined();
  });

  it('sync callback resolves', async () => {
    await expect(scope(() => 42)).resolves.toBe(42);
  });

  it('async callback resolves', async () => {
    await expect(scope(async () => 'ok')).resolves.toBe('ok');
  });

  it('sequential awaited work inside callback is owned (no spawn needed)', async () => {
    const calls: string[] = [];
    const result = await scope(async () => {
      calls.push('a');
      await Promise.resolve();
      calls.push('b');
      return 'done';
    });
    expect(calls).toEqual(['a', 'b']);
    expect(result).toBe('done');
  });

  it('one spawned child resolves and scope awaits it', async () => {
    const order: string[] = [];
    const result = await scope(async (s) => {
      const child = s.spawn(async () => {
        await Promise.resolve();
        order.push('child');
        return 7;
      });
      order.push('after-spawn');
      const v = await child;
      order.push(`got-${v}`);
      return v;
    });
    expect(result).toBe(7);
    expect(order).toContain('after-spawn');
    expect(order).toContain('child');
  });

  it('multiple spawned children', async () => {
    const result = await scope(async (s) => {
      const a = s.spawn(async () => 1);
      const b = s.spawn(async () => 2);
      return (await a) + (await b);
    });
    expect(result).toBe(3);
  });

  it('unawaited child failure fails the scope', async () => {
    const stop = trackUnhandled();
    try {
      await expect(
        scope(async (s) => {
          s.spawn(async () => {
            throw new Error('unawaited-fail');
          });
          await Promise.resolve();
          return 'ignored';
        }),
      ).rejects.toThrow('unawaited-fail');
    } finally {
      stop();
    }
    expect(
      unhandled.filter((u) => String(u).includes('unawaited-fail')),
    ).toHaveLength(0);
  });

  it('callback returns before child finishes; scope awaits child', async () => {
    const order: string[] = [];
    await scope(async (s) => {
      s.spawn(async () => {
        await new Promise((r) => setTimeout(r, 5));
        order.push('child-done');
        return 1;
      });
      order.push('callback-returned');
      return 'result';
    });
    expect(order).toEqual(['callback-returned', 'child-done']);
  });

  it('child failure cancels other children and rejects', async () => {
    const order: string[] = [];
    const stop = trackUnhandled();
    try {
      await expect(
        scope(async (s) => {
          s.spawn(async (signal) => {
            try {
              await new Promise((_r, rej) => {
                signal.addEventListener('abort', () => rej(signal.reason));
                setTimeout(() => {
                  order.push('slow-done');
                }, 50);
              });
              return 'slow';
            } catch (e) {
              order.push('slow-cancelled');
              throw e;
            }
          });
          s.spawn(async () => {
            throw new Error('fail-fast');
          });
          await new Promise((r) => setTimeout(r, 5));
          order.push('after-children');
        }),
      ).rejects.toThrow('fail-fast');
    } finally {
      stop();
    }
    expect(order).toContain('slow-cancelled');
  });

  it('callback failure rejects and cancels children', async () => {
    const order: string[] = [];
    await expect(
      scope(async (s) => {
        s.spawn(async (signal) => {
          try {
            await new Promise((_r, rej) => {
              signal.addEventListener('abort', () => rej(signal.reason));
              setTimeout(() => order.push('child-done'), 50);
            });
            return 1;
          } catch {
            order.push('child-cancelled');
            throw signal.reason;
          }
        });
        throw new Error('callback-fail');
      }),
    ).rejects.toThrow('callback-fail');
    expect(order).toContain('child-cancelled');
  });

  it('external cancellation rejects with external reason', async () => {
    const ctrl = new AbortController();
    const p = scope(
      async (s) => {
        await new Promise((_r, rej) => {
          s.signal.addEventListener('abort', () => rej(s.signal.reason));
          setTimeout(() => {}, 50);
        });
      },
      { signal: ctrl.signal },
    );
    const cause = new Error('external-stop');
    ctrl.abort(cause);
    await expect(p).rejects.toBe(cause);
  });

  it('already-aborted external signal rejects at start', async () => {
    const ctrl = new AbortController();
    const cause = new Error('pre-aborted');
    ctrl.abort(cause);
    await expect(
      scope(
        async () => {
          return 'never';
        },
        { signal: ctrl.signal },
      ),
    ).rejects.toBe(cause);
  });

  it('child fails first, callback throws later: child error wins', async () => {
    await expect(
      scope(async (s) => {
        s.spawn(async () => {
          throw new Error('child-first');
        });
        await new Promise((r) => setTimeout(r, 5));
        throw new Error('callback-later');
      }),
    ).rejects.toThrow('child-first');
  });

  it('multiple child failures: first error wins, others observed', async () => {
    const stop = trackUnhandled();
    try {
      await expect(
        scope(async (s) => {
          s.spawn(async () => {
            throw new Error('first-fail');
          });
          await new Promise((r) => setTimeout(r, 2));
          s.spawn(async () => {
            throw new Error('second-fail');
          });
          await new Promise((r) => setTimeout(r, 5));
        }),
      ).rejects.toThrow('first-fail');
    } finally {
      stop();
    }
    // second-fail must have been observed, not unhandled
    expect(
      unhandled.filter((u) => String(u).includes('second-fail')),
    ).toHaveLength(0);
  });

  it('spawn after callback returned throws synchronously', async () => {
    let spawnError: unknown = null;
    let spawnedAfter = false;
    await scope(async (s) => {
      const p = s.spawn(async () => 'child');
      await p;
      // capture a late spawn attempt
      setTimeout(() => {
        try {
          s.spawn(async () => 'too-late');
          spawnedAfter = true;
        } catch (e) {
          spawnError = e;
        }
      }, 0);
      return 'done';
    });
    // let the late spawn attempt run
    await new Promise((r) => setTimeout(r, 10));
    expect(spawnedAfter).toBe(false);
    expect(spawnError).toBeInstanceOf(TypeError);
  });

  it('spawn during cancellation throws synchronously', async () => {
    const ctrl = new AbortController();
    let spawnError: unknown = null;
    let spawned = false;
    const p = scope(
      async (s) => {
        await new Promise((r) => setTimeout(r, 5));
        try {
          s.spawn(async () => 'late');
          spawned = true;
        } catch (e) {
          spawnError = e;
        }
        await new Promise((r) => setTimeout(r, 5));
        return 'done';
      },
      { signal: ctrl.signal },
    );
    ctrl.abort(new Error('cancel'));
    await expect(p).rejects.toThrow('cancel');
    expect(spawned).toBe(false);
    expect(spawnError).toBeInstanceOf(TypeError);
  });

  it('zero-arg worker is valid', async () => {
    const result = await scope(async (s) => {
      return s.spawn(async () => 5);
    });
    expect(result).toBe(5);
  });

  it('signal-aware worker receives scope signal', async () => {
    await scope(async (s) => {
      const sawSignal = await s.spawn(async (signal) => signal === s.signal);
      expect(sawSignal).toBe(true);
    });
  });

  it('sync worker returning a value is valid', async () => {
    const result = await scope(async (s) => s.spawn(() => 'sync'));
    expect(result).toBe('sync');
  });

  it('uncooperative finite child delays scope but completes', async () => {
    const order: string[] = [];
    const result = await scope(async (s) => {
      s.spawn(async () => {
        await new Promise((r) => setTimeout(r, 5));
        order.push('uncoop-done');
        return 'u';
      });
      return 'main';
    });
    expect(result).toBe('main');
    expect(order).toContain('uncoop-done');
  });

  it('scope with no children and normal return', async () => {
    const result = await scope(async () => 'plain');
    expect(result).toBe('plain');
  });

  it('rejects non-function callback', () => {
    // @ts-expect-error testing runtime validation
    expect(() => scope(null)).toThrow(TypeError);
  });
});
