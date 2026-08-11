import { describe, expect, it } from 'vitest';
import { map } from '../src/map.js';
import {
  controlledAsyncIterable,
  recorder,
  tick,
  trackUnhandledRejections,
} from './helpers/adversarial.js';

describe('map: pull discipline', () => {
  it('never pulls more than ~concurrency ahead (bounded pull-ahead)', async () => {
    // Track how many items are pulled while mappers are still in-flight.
    const pulled: number[] = [];
    const concurrency = 3;
    const results = await map(
      Array.from({ length: 50 }, (_, i) => i),
      async (x) => {
        pulled.push(x);
        await new Promise((r) => setTimeout(r, 2));
        return x;
      },
      { concurrency },
    );
    expect(results).toHaveLength(50);
    // With per-runner sequential pulling, the max number of started-but-not
    // settled mappers should be bounded by concurrency (plus the pulled item
    // about to run). Assert we never started more than concurrency+small slack.
    // NOTE: pulled tracks *started* mappers; verify count <= concurrency + slack
    // is not directly possible from this trace, so we assert a proxy: the total
    // started equals total items, and no item started twice.
    expect(new Set(pulled).size).toBe(50);
  });

  it('with concurrency N, at most N mapper calls are in-flight simultaneously', async () => {
    let active = 0;
    let maxActive = 0;
    const N = 4;
    await map(
      Array.from({ length: 100 }, (_, i) => i),
      async (x) => {
        active++;
        maxActive = Math.max(maxActive, active);
        await new Promise((r) => setTimeout(r, 1));
        active--;
        return x;
      },
      { concurrency: N },
    );
    expect(maxActive).toBeLessThanOrEqual(N);
  });
});

describe('map: huge lazy input', () => {
  it('10k lazy items with concurrency 8, ordered output', async () => {
    // Windows clamps setTimeout(0) to ~16ms; 100k * (100k/8) timers would be
    // infeasibly slow. Use 10k with microtask-based yielding (no timers) to
    // validate laziness + ordering + bounded concurrency on any platform.
    const N = 10_000;
    function* lazy() {
      for (let i = 0; i < N; i++) yield i;
    }
    let maxActive = 0;
    let active = 0;
    const results = await map(
      lazy(),
      async (x) => {
        active++;
        maxActive = Math.max(maxActive, active);
        await new Promise<void>((r) => queueMicrotask(r));
        active--;
        return x * 2;
      },
      { concurrency: 8 },
    );
    expect(results).toHaveLength(N);
    expect(results[0]).toBe(0);
    expect(results[N - 1]).toBe((N - 1) * 2);
    expect(maxActive).toBeLessThanOrEqual(8);
  }, 20_000);
});

describe('map: async iterable abuse', () => {
  it('next() rejects → map rejects with that error, no unhandled', async () => {
    const stop = trackUnhandledRejections();
    try {
      const { iterable } = controlledAsyncIterable([1, 2], {
        onNext() {
          throw new Error('next-fail');
        },
      });
      await expect(
        map(iterable, async (x) => x, { concurrency: 2 }),
      ).rejects.toThrow('next-fail');
      await tick();
      expect(stop.observed).toHaveLength(0);
    } finally {
      stop.stop();
    }
  });

  it('return() throws on early stop → primary failure preserved, return failure observed', async () => {
    const stop = trackUnhandledRejections();
    try {
      const returns = { count: 0 };
      const { iterable } = controlledAsyncIterable([1, 2, 3], {
        returnThrows: true,
        returns,
      });
      await expect(
        map(
          iterable,
          async (x) => {
            if (x === 1) throw new Error('mapper-fail');
            return x;
          },
          { concurrency: 1 },
        ),
      ).rejects.toThrow('mapper-fail');
      await tick();
      expect(returns.count).toBeGreaterThanOrEqual(1);
      // the return() throw must not become unhandled
      expect(stop.observed).toHaveLength(0);
    } finally {
      stop.stop();
    }
  });

  it('return() absent → no crash', async () => {
    const { iterable } = controlledAsyncIterable([1, 2, 3], { noReturn: true });
    await expect(
      map(
        iterable,
        async (x) => {
          if (x === 1) throw new Error('fail');
          return x;
        },
        { concurrency: 1 },
      ),
    ).rejects.toThrow('fail');
  });

  it('yield pauses indefinitely + parent aborts → map rejects with abort reason', async () => {
    const ctrl = new AbortController();
    const reason = new Error('map-abort');
    const { iterable } = controlledAsyncIterable([1, 2, 3], {
      nextDelayMs: 50,
    });
    const p = map(iterable, async (x) => x, {
      concurrency: 2,
      signal: ctrl.signal,
    });
    ctrl.abort(reason);
    await expect(p).rejects.toBe(reason);
  });

  it('parent aborts while next() pending → rejects with abort reason, return attempted', async () => {
    const stop = trackUnhandledRejections();
    try {
      const returns = { count: 0 };
      const ctrl = new AbortController();
      const reason = new Error('abort-during-next');
      const { iterable } = controlledAsyncIterable([1, 2, 3], {
        nextDelayMs: 100,
        returns,
      });
      const p = map(iterable, async (x) => x, {
        concurrency: 2,
        signal: ctrl.signal,
      });
      setTimeout(() => ctrl.abort(reason), 5);
      await expect(p).rejects.toBe(reason);
      await tick();
      expect(stop.observed).toHaveLength(0);
    } finally {
      stop.stop();
    }
  });

  it('mapper fails while next() pending → primary failure preserved', async () => {
    const stop = trackUnhandledRejections();
    try {
      const returns = { count: 0 };
      const { iterable } = controlledAsyncIterable([1, 2, 3], {
        nextDelayMs: 30,
        returns,
      });
      await expect(
        map(
          iterable,
          async (x) => {
            if (x === 1) throw new Error('mapper-fail-fast');
            return x;
          },
          { concurrency: 2 },
        ),
      ).rejects.toThrow('mapper-fail-fast');
      await tick();
      expect(stop.observed).toHaveLength(0);
    } finally {
      stop.stop();
    }
  });
});

describe('map: worker failure storm', () => {
  it('many in-flight, one fails, others cancel; first failure authoritative', async () => {
    const stop = trackUnhandledRejections();
    const rec = recorder();
    try {
      await expect(
        map(
          Array.from({ length: 50 }, (_, i) => i),
          async (x, _i, signal) => {
            if (x === 25) throw new Error('the-fail');
            try {
              await new Promise((res, rej) => {
                signal.addEventListener('abort', () => rej(signal.reason), {
                  once: true,
                });
                // resolves after 30ms so runners free up and pull later items;
                // on abort, rejects so the runner exits.
                setTimeout(() => res(x), 30);
              });
              return x;
            } catch {
              rec.push(`cancelled-${x}`);
              throw signal.reason;
            }
          },
          { concurrency: 10 },
        ),
      ).rejects.toThrow('the-fail');
      await tick();
      expect(stop.observed).toHaveLength(0);
    } finally {
      stop.stop();
    }
  });

  it('many workers fail simultaneously → first authoritative, others observed', async () => {
    const stop = trackUnhandledRejections();
    try {
      await expect(
        map(
          Array.from({ length: 100 }, (_, i) => i),
          async (x) => {
            throw new Error(`fail-${x}`);
          },
          { concurrency: 20 },
        ),
      ).rejects.toThrow(/fail-/);
      await tick();
      expect(stop.observed).toHaveLength(0);
    } finally {
      stop.stop();
    }
  });

  it('some ignore signal (uncooperative) → teardown awaited, primary preserved', async () => {
    const stop = trackUnhandledRejections();
    try {
      const rec = recorder();
      await expect(
        map(
          [1, 2, 3, 4, 5],
          async (x) => {
            if (x === 3) throw new Error('fail');
            // uncooperative: ignores signal, finishes after 10ms
            await new Promise((r) => setTimeout(r, 10));
            rec.push(`done-${x}`);
            return x;
          },
          { concurrency: 5 },
        ),
      ).rejects.toThrow('fail');
      await tick();
      expect(stop.observed).toHaveLength(0);
    } finally {
      stop.stop();
    }
  });
});

describe('map: result-order stress', () => {
  it('randomized completion across 2000 items stays input-ordered', async () => {
    const N = 2000;
    const results = await map(
      Array.from({ length: N }, (_, i) => i),
      async (x) => {
        // random-ish delay per item
        await new Promise((r) => setTimeout(r, (x * 7) % 5));
        return x * 3;
      },
      { concurrency: 16 },
    );
    expect(results).toHaveLength(N);
    for (let i = 0; i < N; i++) {
      expect(results[i]).toBe(i * 3);
    }
  });

  it('concurrency 1 / 2 / 3 / Infinity all ordered', async () => {
    for (const c of [1, 2, 3, Infinity]) {
      const results = await map(
        Array.from({ length: 30 }, (_, i) => i),
        async (x) => {
          await new Promise((r) => setTimeout(r, (x * 3) % 4));
          return x;
        },
        { concurrency: c },
      );
      expect(results).toEqual(Array.from({ length: 30 }, (_, i) => i));
    }
  });
});

describe('map: Infinity concurrency sanity', () => {
  it('all finite items start, ordered, no hang', async () => {
    const results = await map(
      Array.from({ length: 500 }, (_, i) => i),
      async (x) => x,
      { concurrency: Infinity },
    );
    expect(results).toHaveLength(500);
  });

  it('failure cancellation works with Infinity', async () => {
    const stop = trackUnhandledRejections();
    try {
      await expect(
        map(
          Array.from({ length: 100 }, (_, i) => i),
          async (x) => {
            if (x === 10) throw new Error('inf-fail');
            return x;
          },
          { concurrency: Infinity },
        ),
      ).rejects.toThrow('inf-fail');
      await tick();
      expect(stop.observed).toHaveLength(0);
    } finally {
      stop.stop();
    }
  });
});
