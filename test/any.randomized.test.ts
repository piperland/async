// PIPER ASYNC — randomized deterministic schedules for strong first-success `any()`.
// 100 seeds, fixed RNG (no Math.random), asserting ownership invariants.

import { describe, expect, it } from 'vitest';
import { any } from '../src/any.js';

// Deterministic PRNG (mulberry32).
function mulberry32(seed: number) {
  let a = seed >>> 0;
  return () => {
    a |= 0;
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
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

// Instrument unhandled rejections (assert none leak).
const unhandled: unknown[] = [];
function trackUnhandled() {
  const handler = (reason: unknown) => {
    unhandled.push(reason);
  };
  process.on('unhandledRejection', handler);
  return () => process.off('unhandledRejection', handler);
}

describe('any — randomized schedules', () => {
  it('100 seeds: at most one success selected, all secondary failures observed, no unhandled', async () => {
    const unsub = trackUnhandled();
    for (let seed = 1; seed <= 100; seed++) {
      const rng = mulberry32(seed);
      const count = 2 + Math.floor(rng() * 6); // 2..7 workers
      // Randomly decide whether ANY worker succeeds.
      const hasSuccess = rng() < 0.7;
      const successIndex = hasSuccess ? Math.floor(rng() * count) : -1;
      // Random success/failure, random delay, random cleanup delay.
      const workers = Array.from({ length: count }, (_, i) => {
        const succeeds = i === successIndex;
        const delay = Math.floor(rng() * 20);
        const cleanupDelay = Math.floor(rng() * 10);
        const rejectWith =
          rng() < 0.5 ? new Error(`w${i} failed`) : `string-${i}`;
        return async (signal: AbortSignal) => {
          await new Promise<void>((res) => setTimeout(res, delay));
          if (succeeds) return `value-${i}`;
          // Non-winner: fail unless already selected -> then observe cancellation.
          if (signal.aborted) {
            await new Promise((res) => setTimeout(res, cleanupDelay));
            throw signal.reason;
          }
          throw rejectWith;
        };
      });

      const result = await any(workers).then(
        (v) => ({ ok: true as const, v }),
        (e) => ({ ok: false as const, e }),
      );

      if (hasSuccess) {
        expect(result.ok).toBe(true);
        expect(result.v).toBe(`value-${successIndex}`);
      } else {
        expect(result.ok).toBe(false);
        expect(result.e).toBeInstanceOf(AggregateError);
        expect(result.e.errors).toHaveLength(count);
      }
    }
    await new Promise((res) => setTimeout(res, 30));
    expect(unhandled).toEqual([]);
    unsub();
  });

  it('randomized parent-abort timing: success that settles before abort stays, abort-before-settle wins', async () => {
    const unsub = trackUnhandled();
    for (let seed = 1; seed <= 50; seed++) {
      const rng = mulberry32(seed + 1000);
      const ctrl = new AbortController();
      // Deterministic gate: settle the worker BEFORE or AFTER the abort fires.
      const succeedFirst = rng() < 0.5;
      const gate = makeDeferred();
      const p = any(
        [
          async (signal) => {
            await gate.promise; // hold until we decide
            if (!signal.aborted) return 'value';
            throw signal.reason;
          },
        ],
        { signal: ctrl.signal },
      ).then(
        (v) => ({ kind: 'success' as const, v }),
        (e) => ({ kind: 'abort' as const, reason: e.message }),
      );
      if (succeedFirst) {
        gate.resolve();
        await new Promise((res) => setTimeout(res, 2)); // let success win
        ctrl.abort(new Error('cancel'));
      } else {
        ctrl.abort(new Error('cancel'));
        await new Promise((res) => setTimeout(res, 2)); // let abort win
        gate.resolve();
      }
      const r = await p;
      if (succeedFirst) {
        expect(r.kind).toBe('success');
        expect(r.v).toBe('value');
      } else {
        expect(r.kind).toBe('abort');
        expect(r.reason).toBe('cancel');
      }
    }
    await new Promise((res) => setTimeout(res, 30));
    expect(unhandled).toEqual([]);
    unsub();
  });
});
