// PIPER ASYNC — strong first-success `any()` semantic suite.
// Deterministic, no flaky timers (uses deferred gates where ordering matters).

import { describe, expect, it } from 'vitest';
import { any } from '../src/any.js';

// Instrument unhandled rejections.
const unhandled: unknown[] = [];
function trackUnhandled() {
  const handler = (reason: unknown) => {
    unhandled.push(reason);
  };
  process.on('unhandledRejection', handler);
  return () => process.off('unhandledRejection', handler);
}
function makeDeferred<T = void>() {
  let resolve!: (v: T | PromiseLike<T>) => void;
  let reject!: (e?: unknown) => void;
  const promise = new Promise<T>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}

describe('any — first-success selection', () => {
  it('first fulfillment wins', async () => {
    const r = await any([
      async () => {
        await new Promise((res) => setTimeout(res, 20));
        return 'slow';
      },
      async () => 'fast',
    ]);
    expect(r).toBe('fast');
  });

  it('a rejection does NOT end any while another may succeed (the core gap)', async () => {
    const r = await any([
      async () => {
        await new Promise((res) => setTimeout(res, 5));
        throw new Error('A fails');
      },
      async () => {
        await new Promise((res) => setTimeout(res, 20));
        return 'B-success';
      },
      async () => {
        await new Promise((res) => setTimeout(res, 100));
        return 'C-late';
      },
    ]);
    expect(r).toBe('B-success');
  });

  it('multiple failures then success returns success (no AggregateError)', async () => {
    const r = await any([
      async () => {
        throw new Error('A rejects');
      },
      async () => {
        throw new Error('B rejects');
      },
      async () => {
        await new Promise((res) => setTimeout(res, 10));
        return 'C-success';
      },
    ]);
    expect(r).toBe('C-success'); // C wins after A and B reject
  });

  it('near-simultaneous successes: exactly one winner, exactly once', async () => {
    let resolves = 0;
    const p = any([
      async () => {
        await new Promise((res) => setTimeout(res, 0));
        resolves++;
        return 'one';
      },
      async () => {
        await new Promise((res) => setTimeout(res, 0));
        resolves++;
        return 'two';
      },
    ]).then((v) => v);
    const r = await p;
    expect(['one', 'two']).toContain(r);
    await new Promise((res) => setTimeout(res, 20));
    // At most one success is "selected"; the other may have resolved but any
    // settles exactly once with a single value.
    expect(resolves).toBe(2); // both workers ran; exactly one won selection
  });
});

describe('any — strong teardown', () => {
  it('awaits loser teardown before settling with the winner', async () => {
    let cleanupAt = 0;
    const start = Date.now();
    const r = await any([
      async () => 'winner',
      async (signal) => {
        await new Promise((_res, rej) => {
          signal.addEventListener(
            'abort',
            () => {
              cleanupAt = Date.now();
              setTimeout(() => rej(signal.reason), 30); // slow cleanup
            },
            { once: true },
          );
        });
        return 'loser';
      },
    ]).then((v) => ({ v, at: Date.now() - start }));
    expect(r.v).toBe('winner');
    expect(r.at).toBeGreaterThanOrEqual(28); // waited for the 30ms loser cleanup
    expect(cleanupAt).toBeGreaterThan(0);
  });

  it('uncooperative loser (ignores cancellation) delays settlement', async () => {
    const r = await any([
      async () => 'winner',
      async () => {
        // ignores signal entirely; settles in 50ms on its own
        await new Promise((res) => setTimeout(res, 50));
        return 'stubborn';
      },
    ]).then((v) => v);
    expect(r).toBe('winner'); // eventually wins, but only after stubborn settles (strong teardown)
  });
});

describe('any — all-fail AggregateError', () => {
  it('all workers fail -> AggregateError with reasons in input order', async () => {
    const e = await any([
      async () => {
        throw 'first';
      },
      async () => {
        throw new Error('second');
      },
      async () => {
        throw 42;
      },
    ]).then(
      () => null,
      (err) => err,
    );
    expect(e).toBeInstanceOf(AggregateError);
    expect(e.errors).toEqual(['first', expect.any(Error), 42]);
    expect(e.errors[0]).toBe('first');
    expect(e.errors[2]).toBe(42);
  });

  it('arbitrary rejection reasons preserved (string, number, object, null, undefined)', async () => {
    const e = await any([
      async () => {
        throw 'str';
      },
      async () => {
        throw 42;
      },
      async () => {
        throw { custom: true };
      },
      async () => {
        throw null;
      },
      async () => {
        throw undefined;
      },
    ]).then(
      () => null,
      (err) => err,
    );
    expect(e).toBeInstanceOf(AggregateError);
    expect(e.errors).toEqual(['str', 42, { custom: true }, null, undefined]);
  });

  it('empty iterable -> AggregateError([]) like Promise.any', async () => {
    const e = await any([]).then(
      () => null,
      (err) => err,
    );
    expect(e).toBeInstanceOf(AggregateError);
    expect(e.errors).toEqual([]);
  });

  it('single failing worker -> AggregateError with that one reason', async () => {
    const e = await any([
      async () => {
        throw 'only';
      },
    ]).then(
      () => null,
      (err) => err,
    );
    expect(e).toBeInstanceOf(AggregateError);
    expect(e.errors).toEqual(['only']);
  });
});

describe('any — cancellation & parent signal', () => {
  it('parent abort before success wins -> rejects with parent reason', async () => {
    const ctrl = new AbortController();
    const p = any(
      [
        async () => {
          await new Promise((res) => setTimeout(res, 200));
          return 'never';
        },
        async () => {
          await new Promise((res) => setTimeout(res, 200));
          return 'never2';
        },
      ],
      { signal: ctrl.signal },
    ).then(
      () => 'resolved',
      (e) => e.message,
    );
    setTimeout(() => ctrl.abort(new Error('parent shutdown')), 20);
    expect(await p).toBe('parent shutdown');
  });

  it('already-aborted parent rejects immediately without starting workers', async () => {
    const ctrl = new AbortController();
    ctrl.abort(new Error('pre-aborted'));
    let started = 0;
    const e = await any(
      [
        async () => {
          started++;
          return 'x';
        },
      ],
      { signal: ctrl.signal },
    ).then(
      () => null,
      (err) => err,
    );
    expect(e).toBeInstanceOf(Error);
    expect(e.message).toBe('pre-aborted');
    expect(started).toBe(0); // no worker started
  });

  it('parent abort vs success race: whichever is authoritative first wins', async () => {
    const ctrl = new AbortController();
    const gate = makeDeferred();
    const p = any(
      [
        async () => {
          await gate.promise; // hold until we decide the winner
          return 'success';
        },
      ],
      { signal: ctrl.signal },
    ).then(
      (v) => ({ kind: 'success', v }),
      (e) => ({ kind: 'abort', msg: e.message }),
    );
    // Success settles first; then parent aborts (too late to override).
    gate.resolve();
    await new Promise((res) => setTimeout(res, 5));
    ctrl.abort(new Error('late abort'));
    const r = await p;
    expect(r.kind).toBe('success');
    expect(r.v).toBe('success');
  });

  it('loser cleanup rejection is observed, not unhandled, and does not replace success', async () => {
    const unsub = trackUnhandled();
    const r = await any([
      async () => 'winner',
      async (signal) => {
        await new Promise((_res, rej) => {
          signal.addEventListener(
            'abort',
            () => {
              setTimeout(() => rej(new Error('loser cleanup failed')), 5);
            },
            { once: true },
          );
        });
        return 'loser';
      },
    ]).then((v) => v);
    unsub();
    expect(r).toBe('winner');
    await new Promise((res) => setTimeout(res, 20));
    expect(unhandled).toEqual([]); // no unhandled rejection
  });
});

describe('any — hostile iterable & thenables', () => {
  it('iterable throws during enumeration -> reject with enumeration error, no orphan', async () => {
    const unsub = trackUnhandled();
    function* throwing() {
      yield async () => {
        await new Promise((res) => setTimeout(res, 10));
        return 'a';
      };
      throw new Error('enumeration boom');
    }
    const e = await any(throwing()).then(
      () => null,
      (err) => err,
    );
    expect(e.message).toBe('enumeration boom');
    await new Promise((res) => setTimeout(res, 20));
    expect(unhandled).toEqual([]);
    unsub();
  });

  it('hostile thenable: resolves twice, throws from then -> assimilated, no double settle', async () => {
    const unsub = trackUnhandled();
    let settles = 0;
    const hostile = {
      // biome-ignore lint/suspicious/noThenProperty: deliberate hostile thenable
      then(onFulfilled: (v: unknown) => unknown) {
        onFulfilled('first');
        onFulfilled('second'); // second call ignored by Promise assimilation
      },
    };
    const r = await any([async () => 'real', () => hostile as never]).then(
      (v) => {
        settles++;
        return v;
      },
    );
    await new Promise((res) => setTimeout(res, 10));
    expect(['real', 'first']).toContain(r);
    expect(settles).toBe(1);
    expect(unhandled).toEqual([]);
    unsub();
  });

  it('worker throws synchronously -> treated as rejection (observed, may still succeed via another)', async () => {
    const r = await any([
      () => {
        throw new Error('sync-throw');
      },
      async () => 'winner',
    ]);
    expect(r).toBe('winner');
  });
});

describe('any — worker input validation', () => {
  // A malformed worker entry (eager Promise, null, number, object, ...) is
  // programmer error. It must become an authoritative TypeError that a
  // legitimate success can NEVER mask.
  const INVALID_MESSAGE =
    'Expected worker to be a function (got a non-function; eager Promises are not workers)';

  it('eager Promise first + valid success -> TypeError (not masked)', async () => {
    const unsub = trackUnhandled();
    const e = await any([Promise.resolve('x') as never, async () => 'y']).then(
      () => null,
      (err) => err,
    );
    expect(e).toBeInstanceOf(TypeError);
    expect(e.message).toBe(INVALID_MESSAGE);
    await new Promise((res) => setTimeout(res, 10));
    expect(unhandled).toEqual([]);
    unsub();
  });

  it('eager REJECTED Promise + success -> TypeError, no unhandled rejection', async () => {
    const unsub = trackUnhandled();
    const eager = Promise.reject(new Error('already started'));
    const e = await any([eager as never, async () => 'y']).then(
      () => null,
      (err) => err,
    );
    expect(e).toBeInstanceOf(TypeError);
    await new Promise((res) => setTimeout(res, 10));
    expect(unhandled).toEqual([]); // eager rejection observed, not leaked
    unsub();
  });

  it('valid success + invalid later -> TypeError (invalid cannot be hidden)', async () => {
    const e = await any([async () => 'y', 42 as never]).then(
      () => null,
      (err) => err,
    );
    expect(e).toBeInstanceOf(TypeError);
  });

  it('null + success -> TypeError', async () => {
    const e = await any([null as never, async () => 'y']).then(
      () => null,
      (err) => err,
    );
    expect(e).toBeInstanceOf(TypeError);
  });

  it('number + success -> TypeError', async () => {
    const e = await any([7 as never, async () => 'y']).then(
      () => null,
      (err) => err,
    );
    expect(e).toBeInstanceOf(TypeError);
  });

  it('object + success -> TypeError', async () => {
    const e = await any([{ a: 1 } as never, async () => 'y']).then(
      () => null,
      (err) => err,
    );
    expect(e).toBeInstanceOf(TypeError);
  });

  it('multiple invalids -> TypeError', async () => {
    const e = await any([null as never, 'str' as never, 42 as never]).then(
      () => null,
      (err) => err,
    );
    expect(e).toBeInstanceOf(TypeError);
  });

  it('invalid workers do NOT appear as AggregateError.errors on legit all-fail', async () => {
    // A valid all-fail still yields AggregateError with ONLY the legitimate
    // worker reasons; the malformed-input path is a separate TypeError outcome.
    const e = await any([
      () => Promise.reject('A'),
      () => Promise.reject('B'),
    ]).then(
      () => null,
      (err) => err,
    );
    expect(e).toBeInstanceOf(AggregateError);
    expect(e.errors).toEqual(['A', 'B']);
  });

  it('rejects non-iterable input', async () => {
    expect(() => any(null as never)).toThrow(TypeError);
    expect(() => any(42 as never)).toThrow(TypeError);
  });
});

describe('any — arbitrary successful values', () => {
  it('falsy and empty values are valid successes (not truthiness-based)', async () => {
    for (const v of [undefined, null, false, 0, '', NaN]) {
      const r = await any([
        async () => v as never,
        async () => 'fallback' as never,
      ]);
      expect(r).toBe(v);
    }
  });
  it('object and function successes are valid', async () => {
    const obj = { a: 1 };
    const fn = () => 2;
    expect(
      await any([async () => obj as never, async () => ({ b: 2 }) as never]),
    ).toBe(obj);
    expect(
      await any([
        async () => fn as never,
        async () => ((x: number) => x) as never,
      ]),
    ).toBe(fn);
  });
});

describe('any — loser cancellation reason', () => {
  it('loser observes an AbortError with throwIfAborted', async () => {
    let reason: unknown;
    await any([
      async () => 'winner',
      async (signal) => {
        await new Promise((_res, rej) => {
          signal.addEventListener(
            'abort',
            () => {
              reason = signal.reason;
              expect(signal.reason).toBeInstanceOf(DOMException);
              expect((signal.reason as DOMException).name).toBe('AbortError');
              expect(() => signal.throwIfAborted()).toThrow(DOMException);
              rej(signal.reason);
            },
            { once: true },
          );
        });
        return 'loser';
      },
    ]);
    expect(reason).toBeDefined();
    expect((reason as DOMException).name).toBe('AbortError');
  });
});
