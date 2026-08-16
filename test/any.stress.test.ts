// PIPER ASYNC — stress for strong first-success `any()`.
// Large worker counts and all-fail paths. Stable sizes (not a benchmark).

import { describe, expect, it } from 'vitest';
import { any } from '../src/any.js';

describe('any — stress', () => {
  it('1000 workers with many failures before success -> success wins', async () => {
    const count = 1000;
    const successAt = 900; // many failures before the winner
    const r = await any(
      Array.from({ length: count }, (_, i) => async () => {
        if (i === successAt) return `value-${i}`;
        throw new Error(`w${i} failed`);
      }),
    );
    expect(r).toBe(`value-${successAt}`);
  });

  it('1000 workers all fail -> AggregateError with 1000 errors', async () => {
    const count = 1000;
    const e = await any(
      Array.from({ length: count }, (_, i) => async () => {
        throw i;
      }),
    ).then(
      () => null,
      (err) => err,
    );
    expect(e).toBeInstanceOf(AggregateError);
    expect(e.errors).toHaveLength(count);
    expect(e.errors[0]).toBe(0);
    expect(e.errors[999]).toBe(999);
  });

  it('winner near the beginning -> losers cancelled, fast selection', async () => {
    let losersCancelled = 0;
    const r = await any(
      Array.from({ length: 100 }, (_, i) => async (signal: AbortSignal) => {
        if (i === 0) return 'winner-first';
        await new Promise((res, rej) => {
          signal.addEventListener(
            'abort',
            () => {
              losersCancelled++;
              rej(signal.reason);
            },
            { once: true },
          );
          setTimeout(() => res('late'), 5000);
        });
        return 'late';
      }),
    );
    expect(r).toBe('winner-first');
    expect(losersCancelled).toBe(99);
  });

  it('winner near the end -> earlier failures observed, winner returned', async () => {
    const r = await any(
      Array.from({ length: 500 }, (_, i) => async () => {
        if (i === 499) return 'winner-last';
        throw new Error(`w${i} failed`);
      }),
    );
    expect(r).toBe('winner-last');
  });
});
