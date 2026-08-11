import { describe, expect, it } from 'vitest';
import { map } from '../src/map.js';

// Instrument unhandled rejections.
const unhandled: unknown[] = [];
function trackUnhandled() {
  const handler = (reason: unknown) => {
    unhandled.push(reason);
  };
  process.on('unhandledRejection', handler);
  return () => process.off('unhandledRejection', handler);
}

describe('map', () => {
  it('empty iterable returns empty array', async () => {
    await expect(map([], async () => 1, { concurrency: 2 })).resolves.toEqual(
      [],
    );
  });

  it('ordered results', async () => {
    const r = await map([1, 2, 3], async (x) => x * 2, { concurrency: 2 });
    expect(r).toEqual([2, 4, 6]);
  });

  it('concurrency respected (max concurrent)', async () => {
    let active = 0;
    let maxActive = 0;
    await map(
      [1, 2, 3, 4, 5, 6],
      async (x) => {
        active++;
        maxActive = Math.max(maxActive, active);
        await new Promise((r) => setTimeout(r, 5));
        active--;
        return x;
      },
      { concurrency: 2 },
    );
    expect(maxActive).toBeLessThanOrEqual(2);
  });

  it('concurrency 1 is sequential', async () => {
    const order: number[] = [];
    await map(
      [1, 2, 3],
      async (x) => {
        order.push(x);
        await new Promise((r) => setTimeout(r, 1));
        return x;
      },
      { concurrency: 1 },
    );
    expect(order).toEqual([1, 2, 3]);
  });

  it('explicit Infinity concurrency', async () => {
    const r = await map([1, 2, 3], async (x) => x, { concurrency: Infinity });
    expect(r).toEqual([1, 2, 3]);
  });

  it('invalid concurrency: 0', () => {
    expect(() => map([], async () => 1, { concurrency: 0 })).toThrow(
      RangeError,
    );
  });

  it('invalid concurrency: negative', () => {
    expect(() => map([], async () => 1, { concurrency: -1 })).toThrow(
      RangeError,
    );
  });

  it('invalid concurrency: NaN', () => {
    expect(() => map([], async () => 1, { concurrency: Number.NaN })).toThrow(
      RangeError,
    );
  });

  it('invalid concurrency: fractional', () => {
    expect(() => map([], async () => 1, { concurrency: 2.5 })).toThrow(
      RangeError,
    );
  });

  it('sync iterable', async () => {
    const r = await map(new Set([1, 2]), async (x) => x, { concurrency: 2 });
    expect(r).toEqual([1, 2]);
  });

  it('async iterable', async () => {
    async function* gen() {
      yield 1;
      yield 2;
      yield 3;
    }
    const r = await map(gen(), async (x) => x * 10, { concurrency: 2 });
    expect(r).toEqual([10, 20, 30]);
  });

  it('lazy pulling', async () => {
    const pulled: number[] = [];
    async function* gen() {
      for (let i = 0; i < 10; i++) {
        pulled.push(i);
        yield i;
      }
    }
    // with concurrency 1 and a slow mapper, should not pull all up front
    await map(
      gen(),
      async (x) => {
        await new Promise((r) => setTimeout(r, 1));
        return x;
      },
      { concurrency: 1 },
    );
    expect(pulled.length).toBe(10); // eventually pulls all
  });

  it('sync mapper', async () => {
    const r = await map([1, 2, 3], (x) => x + 1, { concurrency: 2 });
    expect(r).toEqual([2, 3, 4]);
  });

  it('zero/one/two/three-parameter mappers', async () => {
    const z = await map([1], async () => 1, { concurrency: 1 });
    expect(z).toEqual([1]);
    const one = await map([1, 2], async (x) => x, { concurrency: 1 });
    expect(one).toEqual([1, 2]);
    const two = await map([1, 2], async (x, i) => x + i, { concurrency: 1 });
    expect(two).toEqual([1, 3]);
    const three = await map(
      [1, 2],
      async (x, i, signal) => x + i + (signal.aborted ? 1 : 0),
      { concurrency: 1 },
    );
    expect(three).toEqual([1, 3]);
  });

  it('worker failure rejects', async () => {
    await expect(
      map(
        [1, 2, 3],
        async (x) => {
          if (x === 2) throw new Error('map-fail');
          return x;
        },
        { concurrency: 2 },
      ),
    ).rejects.toThrow('map-fail');
  });

  it('stop pulling on failure', async () => {
    const pulled: number[] = [];
    async function* gen() {
      for (let i = 0; i < 100; i++) {
        pulled.push(i);
        yield i;
      }
    }
    const stop = trackUnhandled();
    try {
      await expect(
        map(
          gen(),
          async (x) => {
            if (x === 2) throw new Error('stop');
            return x;
          },
          { concurrency: 2 },
        ),
      ).rejects.toThrow('stop');
    } finally {
      stop();
    }
    expect(pulled.length).toBeLessThan(100);
  });

  it('running worker cancellation on failure', async () => {
    const order: string[] = [];
    const stop = trackUnhandled();
    try {
      await expect(
        map(
          [1, 2, 3],
          async (x, _i, signal) => {
            if (x === 2) throw new Error('fail');
            try {
              await new Promise((_r, rej) => {
                signal.addEventListener('abort', () => rej(signal.reason));
                setTimeout(() => order.push(`x${x}-done`), 30);
              });
              return x;
            } catch {
              order.push(`x${x}-cancelled`);
              throw signal.reason;
            }
          },
          { concurrency: 3 },
        ),
      ).rejects.toThrow('fail');
    } finally {
      stop();
    }
    expect(order).toContain('x1-cancelled');
    expect(order).toContain('x3-cancelled');
  });

  it('parent abort', async () => {
    const ctrl = new AbortController();
    const p = map(
      [1, 2, 3],
      async (x, _i, signal) => {
        if (signal.aborted) throw signal.reason;
        await new Promise((_r, rej) => {
          signal.addEventListener('abort', () => rej(signal.reason));
          setTimeout(() => {}, 30);
        });
        return x;
      },
      { concurrency: 2, signal: ctrl.signal },
    );
    ctrl.abort(new Error('map-stop'));
    await expect(p).rejects.toThrow('map-stop');
  });

  it('already-aborted parent', async () => {
    const ctrl = new AbortController();
    ctrl.abort(new Error('pre-stop'));
    await expect(
      map([1, 2, 3], async (x) => x, { concurrency: 2, signal: ctrl.signal }),
    ).rejects.toThrow('pre-stop');
  });

  it('iterator.return called on early stop for async generator', async () => {
    let closed = false;
    async function* gen() {
      try {
        yield 1;
        yield 2;
        yield 3;
      } finally {
        closed = true;
      }
    }
    await expect(
      map(
        gen(),
        async (x) => {
          if (x === 1) throw new Error('early');
          return x;
        },
        { concurrency: 1 },
      ),
    ).rejects.toThrow('early');
    // give the generator a chance to run its finally
    await new Promise((r) => setTimeout(r, 5));
    expect(closed).toBe(true);
  });

  it('uncooperative finite worker', async () => {
    const order: string[] = [];
    const result = await map(
      [1, 2],
      async (x) => {
        await new Promise((r) => setTimeout(r, 5));
        order.push(`done-${x}`);
        return x;
      },
      { concurrency: 2 },
    );
    expect(result).toEqual([1, 2]);
    expect(order).toEqual(['done-1', 'done-2']);
  });

  it('result ordering under out-of-order completion', async () => {
    const r = await map(
      [1, 2, 3],
      async (x) => {
        // reverse completion: index 0 finishes last
        await new Promise((res) => setTimeout(res, (3 - x) * 5));
        return x * 100;
      },
      { concurrency: 3 },
    );
    expect(r).toEqual([100, 200, 300]);
  });

  it('rejects non-iterable', () => {
    // @ts-expect-error testing runtime validation
    expect(() => map(null, async () => 1, { concurrency: 2 })).toThrow(
      TypeError,
    );
  });
});
