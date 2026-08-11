import { describe, expect, it } from 'vitest';
import { race } from '../src/race.js';

// Instrument unhandled rejections.
const unhandled: unknown[] = [];
function trackUnhandled() {
  const handler = (reason: unknown) => {
    unhandled.push(reason);
  };
  process.on('unhandledRejection', handler);
  return () => process.off('unhandledRejection', handler);
}

describe('race', () => {
  it('first fulfillment wins', async () => {
    const r = await race([
      async () => {
        await new Promise((res) => setTimeout(res, 20));
        return 'slow';
      },
      async () => 'fast',
    ]);
    expect(r).toBe('fast');
  });

  it('first rejection wins', async () => {
    await expect(
      race([
        async () => {
          throw new Error('early-reject');
        },
        async () => 'slow',
      ]),
    ).rejects.toThrow('early-reject');
  });

  it('multiple workers', async () => {
    const r = await race([async () => 'a', async () => 'b', async () => 'c']);
    expect(['a', 'b', 'c']).toContain(r);
  });

  it('zero-arg workers are valid', async () => {
    const r = await race([async () => 1, async () => 2]);
    expect([1, 2]).toContain(r);
  });

  it('signal-aware workers receive the race signal', async () => {
    await race([
      async (signal) => {
        expect(signal).toBeInstanceOf(AbortSignal);
        return 1;
      },
      async () => 2,
    ]);
  });

  it('loser cancellation requested', async () => {
    const order: string[] = [];
    const stop = trackUnhandled();
    try {
      const r = await race([
        async (signal) => {
          try {
            await new Promise((_r, rej) => {
              signal.addEventListener('abort', () => rej(signal.reason));
              setTimeout(() => order.push('loser-done'), 50);
            });
            return 'loser';
          } catch {
            order.push('loser-cancelled');
            throw signal.reason;
          }
        },
        async () => 'winner',
      ]);
      expect(r).toBe('winner');
      expect(order).toContain('loser-cancelled');
    } finally {
      stop();
    }
  });

  it('loser cleanup finishes before race settles', async () => {
    const order: string[] = [];
    const r = await race([
      async (signal) => {
        try {
          await new Promise((_r, rej) => {
            signal.addEventListener('abort', () => rej(signal.reason));
            setTimeout(() => {}, 50);
          });
          return 'loser';
        } catch (e) {
          order.push('loser-cleanup');
          throw e;
        }
      },
      async () => 'winner',
    ]);
    expect(r).toBe('winner');
    expect(order).toContain('loser-cleanup');
  });

  it('loser rejection observed, not unhandled', async () => {
    const stop = trackUnhandled();
    try {
      const r = await race([
        async (signal) => {
          await new Promise((_r, rej) => {
            signal.addEventListener('abort', () => rej(signal.reason));
            setTimeout(() => {}, 50);
          });
          return 'loser';
        },
        async () => 'winner',
      ]);
      expect(r).toBe('winner');
    } finally {
      stop();
    }
    expect(unhandled).toHaveLength(0);
  });

  it('uncooperative finite loser delays settlement', async () => {
    const order: string[] = [];
    const start = Date.now();
    const r = await race([
      async () => {
        // ignores signal; finishes after 30ms
        await new Promise((res) => setTimeout(res, 30));
        order.push('loser-done');
        return 'loser';
      },
      async () => 'winner',
    ]);
    expect(r).toBe('winner');
    expect(order).toContain('loser-done');
    expect(Date.now() - start).toBeGreaterThanOrEqual(20);
  });

  it('empty iterable rejects with clear Error', async () => {
    await expect(race([])).rejects.toThrow('at least one worker');
  });

  it('parent abort wins if first', async () => {
    const ctrl = new AbortController();
    const cause = new Error('parent-stop');
    const p = race(
      [
        async (signal) => {
          await new Promise((_r, rej) => {
            signal.addEventListener('abort', () => rej(signal.reason));
            setTimeout(() => {}, 100);
          });
          return 'never';
        },
      ],
      { signal: ctrl.signal },
    );
    ctrl.abort(cause);
    await expect(p).rejects.toBe(cause);
  });

  it('already-aborted parent rejects immediately', async () => {
    const ctrl = new AbortController();
    const cause = new Error('pre-aborted');
    ctrl.abort(cause);
    await expect(
      race([async () => 'ok'], { signal: ctrl.signal }),
    ).rejects.toBe(cause);
  });

  it('sync worker throw', async () => {
    await expect(
      race([
        () => {
          throw new Error('sync-throw');
        },
        async () => 'ok',
      ]),
    ).rejects.toThrow('sync-throw');
  });

  it('sync worker result', async () => {
    const r = await race([() => 'sync', async () => 'async']);
    expect(r).toBe('sync');
  });

  it('iterable throwing while enumerating', async () => {
    // A generator whose iteration throws mid-way.
    function* bad(): Iterable<() => Promise<never>> {
      yield async () => {
        throw new Error('first');
      };
      throw new Error('enum-fail');
    }
    await expect(race(bad())).rejects.toThrow('enum-fail');
  });

  it('rejects non-iterable', () => {
    // @ts-expect-error testing runtime validation
    expect(() => race(null)).toThrow(TypeError);
  });
});
