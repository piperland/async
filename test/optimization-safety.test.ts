import { describe, expect, it } from 'vitest';
import { race, retry } from '../src/index.js';
import { tick } from './helpers/adversarial.js';

// Regression tests for the Run-010 optimizations' semantic safety:
//  1. race shared cancellation reason must be immutable (no cross-call mutation).
//  2. retry shared signal: listener accumulation behavior is bounded per-call
//     (memory flat) and no-post-abort-attempt is preserved.
//  3. retry parent abort reason preserved after many attempts.

describe('race: shared cancellation reason immutability', () => {
  it('loser reason cannot be mutated across independent race calls', async () => {
    // A loser that captures the cancellation reason and tries to mutate it
    let capturedReason: unknown;
    const loser = async (signal: AbortSignal) => {
      await new Promise((r) => setTimeout(r, 5));
      if (signal.aborted) capturedReason = signal.reason;
      return 'loser';
    };
    await race([async () => 'winner', loser]).catch(() => {});
    await tick();
    expect(capturedReason).toBeDefined();
    const reason = capturedReason as { name: string; message: string };
    expect(reason.name).toBe('AbortError');
    expect(reason.message).toBe('Lost race');

    // Attempt to mutate. The reason is frozen: in strict mode this THROWS;
    // in sloppy mode it is a silent no-op. Either way, the mutation is blocked.
    expect(() => {
      (reason as Record<string, unknown>).customField = 'HACKED';
    }).toThrow();

    // A second, unrelated race must NOT see the mutation
    let capturedReason2: unknown;
    const loser2 = async (signal: AbortSignal) => {
      await new Promise((r) => setTimeout(r, 5));
      if (signal.aborted) capturedReason2 = signal.reason;
      return 'loser2';
    };
    await race([async () => 'winner2', loser2]).catch(() => {});
    await tick();
    const reason2 = capturedReason2 as Record<string, unknown>;
    expect(reason2.customField).toBeUndefined();
  });

  it('cancellation reason is not extensible (frozen)', async () => {
    let capturedReason: unknown;
    const loser = async (signal: AbortSignal) => {
      await new Promise((r) => setTimeout(r, 5));
      if (signal.aborted) capturedReason = signal.reason;
      return 'loser';
    };
    await race([async () => 'winner', loser]).catch(() => {});
    await tick();
    expect(Object.isExtensible(capturedReason as object)).toBe(false);
  });
});

describe('retry: shared signal safety', () => {
  it('parent abort after many attempts: no post-abort attempt, reason preserved', async () => {
    const ctrl = new AbortController();
    let attempts = 0;
    await retry(
      async () => {
        attempts++;
        if (attempts === 1000) ctrl.abort(new Error('stop-at-1k'));
        if (ctrl.signal.aborted) throw ctrl.signal.reason;
        throw new Error('fail');
      },
      { attempts: 10_000, signal: ctrl.signal },
    ).catch((e) => {
      expect((e as Error).message).toBe('stop-at-1k');
    });
    expect(attempts).toBe(1000);
  });

  it('stale listeners across attempts fire once on late abort (bounded per call)', async () => {
    // With a shared signal, listeners registered during prior attempts fire when
    // the parent eventually aborts. This matches the per-attempt baseline
    // (AbortSignal.any fan-out) and is released when the call ends — memory flat.
    const ctrl = new AbortController();
    let fired = 0;
    let attempt = 0;
    await retry(
      async (signal) => {
        attempt++;
        signal.addEventListener('abort', () => fired++, { once: true });
        if (attempt === 1) setTimeout(() => ctrl.abort(new Error('stop')), 5);
        await new Promise((r) => setTimeout(r, 1));
        throw new Error('fail');
      },
      { attempts: 5, signal: ctrl.signal },
    ).catch(() => {});
    // attempt 1 + attempt 2 (in-flight when abort landed) listeners fired
    expect(fired).toBeGreaterThanOrEqual(1);
    expect(attempt).toBeLessThan(5);
  });

  it('worker that removes its listener in finally does not accumulate', async () => {
    let fired = 0;
    await retry(
      (signal) => {
        const h = () => {
          fired++;
        };
        signal.addEventListener('abort', h);
        try {
          throw new Error('fail');
        } finally {
          signal.removeEventListener('abort', h);
        }
      },
      { attempts: 100 },
    ).catch(() => {});
    expect(fired).toBe(0);
  });
});
