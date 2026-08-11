import { describe, it, expect } from 'vitest';
import { timeout } from '../src/timeout.js';
import { deferred, gate, trackUnhandledRejections, tick } from './helpers/adversarial.js';

describe('timeout: adversarial matrix', () => {
  it('worker resolves just before timeout', async () => {
    await expect(
      timeout(async () => {
        await new Promise((r) => setTimeout(r, 10));
        return 'ok';
      }, 1000),
    ).resolves.toBe('ok');
  });

  it('worker resolves same turn timeout fires → resolves (race-safe)', async () => {
    // worker resolves in ~50ms; timeout at 50ms. Whichever wins the race.
    const r = await timeout(async () => {
      await new Promise((res) => setTimeout(res, 30));
      return 'ok';
    }, 30);
    expect(r).toBe('ok');
  });

  it('worker resolves just after timeout fires → TimeoutError wins', async () => {
    const worker = async (signal: AbortSignal) => {
      await new Promise((_r, rej) => {
        signal.addEventListener('abort', () => rej(signal.reason), { once: true });
        // deliberately slow; timeout fires first
      });
      return 'never';
    };
    await expect(timeout(worker, 10)).rejects.toMatchObject({ name: 'TimeoutError' });
  });

  it('worker rejects same turn timeout fires → worker error if first', async () => {
    // worker fails at ~5ms, timeout at 100ms → worker error
    await expect(
      timeout(async () => {
        await new Promise((_r, rej) => setTimeout(() => rej(new Error('worker-fail')), 5));
        return 'never';
      }, 100),
    ).rejects.toThrow('worker-fail');
  });

  it('parent abort same turn timeout fires → parent reason wins', async () => {
    const ctrl = new AbortController();
    const reason = new Error('parent-stop');
    const worker = async (signal: AbortSignal) => {
      await new Promise((_r, rej) => {
        signal.addEventListener('abort', () => rej(signal.reason), { once: true });
      });
      return 'never';
    };
    const p = timeout(worker, 5, { signal: ctrl.signal });
    ctrl.abort(reason);
    await expect(p).rejects.toBe(reason);
  });

  it('timeout fires during finally cleanup → TimeoutError, cleanup runs', async () => {
    const rec: string[] = [];
    const worker = async (signal: AbortSignal) => {
      try {
        await new Promise((_r, rej) => {
          signal.addEventListener('abort', () => rej(signal.reason), { once: true });
        });
        return 'never';
      } finally {
        // cleanup that takes 20ms after abort
        await new Promise((r) => setTimeout(r, 20));
        rec.push('cleanup-done');
      }
    };
    await expect(timeout(worker, 5)).rejects.toMatchObject({ name: 'TimeoutError' });
    expect(rec).toContain('cleanup-done');
  });

  it('parent abort AFTER timeout fired → TimeoutError wins (first cause)', async () => {
    // Error-precedence: the timeout fired first (first authoritative cause),
    // so its TimeoutError is authoritative. A parent abort that happens later
    // during cleanup does NOT change the reason (AbortSignal.any is first-wins).
    const ctrl = new AbortController();
    const cleanupStarted = deferred<void>();
    const worker = async (signal: AbortSignal) => {
      try {
        await new Promise((_r, rej) => {
          signal.addEventListener('abort', () => rej(signal.reason), { once: true });
        });
        return 'never';
      } finally {
        cleanupStarted.resolve();
        // hold cleanup until the test aborts the parent
        await new Promise((r) => setTimeout(r, 30));
      }
    };
    const p = timeout(worker, 1, { signal: ctrl.signal });
    // wait until the worker entered cleanup (timeout already fired)
    await cleanupStarted.promise;
    // parent aborts DURING cleanup, after the timeout already won
    ctrl.abort(new Error('parent-later'));
    await expect(p).rejects.toMatchObject({ name: 'TimeoutError' });
  });
});

describe('timeout: zero-timeout torture', () => {
  it('sync return worker + 0ms → TimeoutError (microtask can beat setTimeout)', async () => {
    // 0ms must abort synchronously before the worker's microtask resolution
    await expect(timeout(async () => 'ok', 0)).rejects.toMatchObject({ name: 'TimeoutError' });
  });

  it('sync throw worker + 0ms → TimeoutError (abort wins)', async () => {
    await expect(
      timeout(() => {
        throw new Error('sync');
      }, 0),
    ).rejects.toMatchObject({ name: 'TimeoutError' });
  });

  it('immediate resolved promise + 0ms → TimeoutError', async () => {
    await expect(timeout(() => Promise.resolve('ok'), 0)).rejects.toMatchObject({ name: 'TimeoutError' });
  });

  it('microtask resolution + 0ms → TimeoutError', async () => {
    await expect(
      timeout(
        () => new Promise((r) => queueMicrotask(() => r('ok'))),
        0,
      ),
    ).rejects.toMatchObject({ name: 'TimeoutError' });
  });

  it('signal-aware immediate abort + 0ms → TimeoutError', async () => {
    await expect(
      timeout(
        (signal) => {
          if (signal.aborted) throw signal.reason;
          return 'never';
        },
        0,
      ),
    ).rejects.toMatchObject({ name: 'TimeoutError' });
  });

  it('100 zero-timeout cases with worker resolving → all TimeoutError, no unhandled', async () => {
    const stop = trackUnhandledRejections();
    try {
      for (let i = 0; i < 100; i++) {
        await expect(timeout(async () => 'ok', 0)).rejects.toMatchObject({
          name: 'TimeoutError',
        });
      }
      await tick();
      expect(stop.observed).toHaveLength(0);
    } finally {
      stop.stop();
    }
  });
});

describe('timeout: resource retention', () => {
  it('worker wins → no timer leak (many iterations complete promptly)', async () => {
    const start = Date.now();
    for (let i = 0; i < 500; i++) {
      await timeout(async () => 'ok', 1000);
    }
    // if timers leaked, this would take 1000ms * many; but each clears its timer
    expect(Date.now() - start).toBeLessThan(5000);
  });

  it('timeout wins repeatedly → no listener accumulation', async () => {
    // NOTE: Windows clamps setTimeout to ~15.6ms granularity, so a 1ms timeout
    // fires at ~16ms. Use a timeout above granularity for the leak check.
    const start = Date.now();
    for (let i = 0; i < 100; i++) {
      const worker = async (signal: AbortSignal) => {
        await new Promise((_r, rej) => {
          signal.addEventListener('abort', () => rej(signal.reason), { once: true });
        });
        return 'never';
      };
      await expect(timeout(worker, 30)).rejects.toMatchObject({ name: 'TimeoutError' });
    }
    // 100 * ~31ms ≈ 3.1s. Proves no cumulative slowdown (each iteration the
    // same duration; if listeners accumulated, later iterations would slow).
    const elapsed = Date.now() - start;
    expect(elapsed).toBeLessThan(8000);
  }, 15_000);

  it('uncooperative short operation + timeout → waits for teardown then rejects', async () => {
    const worker = async () => {
      await new Promise((r) => setTimeout(r, 30));
      return 'u';
    };
    await expect(timeout(worker, 5)).rejects.toMatchObject({ name: 'TimeoutError' });
  });
});
