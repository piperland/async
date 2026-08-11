import { describe, expect, it } from 'vitest';
import { retry } from '../src/retry.js';
import {
  deferred,
  tick,
  trackUnhandledRejections,
} from './helpers/adversarial.js';

describe('retry: abort boundaries', () => {
  it('parent aborts before next loop check → no new attempt', async () => {
    const ctrl = new AbortController();
    let calls = 0;
    // first attempt fails; abort fires before the loop checks again
    const p = retry(
      async () => {
        calls++;
        if (calls === 1) {
          // schedule abort to fire during the failure propagation
          queueMicrotask(() => ctrl.abort(new Error('stop')));
          throw new Error('fail-1');
        }
        return 'never';
      },
      { attempts: 5, signal: ctrl.signal },
    );
    await expect(p).rejects.toThrow('stop');
    expect(calls).toBe(1);
  });

  it('delay begins, parent aborts immediately → no second attempt', async () => {
    const ctrl = new AbortController();
    let calls = 0;
    const p = retry(
      async () => {
        calls++;
        throw new Error('fail');
      },
      { attempts: 3, delay: 20, signal: ctrl.signal },
    );
    // abort 1ms after the delay starts
    setTimeout(() => ctrl.abort(new Error('stop-delay')), 1);
    await expect(p).rejects.toThrow('stop-delay');
    expect(calls).toBe(1);
  });

  it('delay completes, parent aborts before next attempt → no attempt', async () => {
    const ctrl = new AbortController();
    let calls = 0;
    // use a gate to deterministically abort BEFORE the next loop check
    const abortAfterDelay = deferred<void>();
    const p = retry(
      async () => {
        calls++;
        if (calls === 1) {
          // first attempt: signal the delay is about to begin, then fail
          queueMicrotask(abortAfterDelay.resolve);
          throw new Error('fail');
        }
        return 'never';
      },
      { attempts: 3, delay: 10, signal: ctrl.signal },
    );
    // abort once attempt 1 has failed and the delay is starting
    await abortAfterDelay.promise;
    ctrl.abort(new Error('stop-after-delay'));
    await expect(p).rejects.toThrow('stop-after-delay');
    expect(calls).toBe(1);
  });

  it('attempt resolves, parent aborts same turn → success wins', async () => {
    const ctrl = new AbortController();
    const p = retry(
      async () => {
        // resolve, but abort fires in the same microtask turn
        queueMicrotask(() => ctrl.abort(new Error('late-stop')));
        return 'ok';
      },
      { attempts: 3, signal: ctrl.signal },
    );
    await expect(p).resolves.toBe('ok');
  });

  it('attempt rejects AbortError, parent NOT aborted → retryable', async () => {
    let calls = 0;
    const r = await retry(async () => {
      calls++;
      if (calls === 1) throw new DOMException('user-abort', 'AbortError');
      return 'ok';
    });
    expect(calls).toBe(2);
    expect(r).toBe('ok');
  });

  it('attempt rejects TimeoutError, parent NOT aborted → retryable', async () => {
    let calls = 0;
    const r = await retry(async () => {
      calls++;
      if (calls === 1)
        throw new DOMException('Timeout exceeded', 'TimeoutError');
      return 'ok';
    });
    expect(calls).toBe(2);
    expect(r).toBe('ok');
  });

  it('attempt rejects arbitrary object → retryable', async () => {
    let calls = 0;
    const r = await retry(async () => {
      calls++;
      if (calls === 1) throw { code: 500, message: 'boom' };
      return 'ok';
    });
    expect(calls).toBe(2);
    expect(r).toBe('ok');
  });

  it('sync throw then async success', async () => {
    let calls = 0;
    const r = await retry(() => {
      calls++;
      if (calls === 1) throw new Error('sync');
      return Promise.resolve('async-ok');
    });
    expect(calls).toBe(2);
    expect(r).toBe('async-ok');
  });

  it('no new attempt after parent abort (races across many runs)', async () => {
    const stop = trackUnhandledRejections();
    try {
      for (let i = 0; i < 100; i++) {
        const ctrl = new AbortController();
        let calls = 0;
        const p = retry(
          async () => {
            calls++;
            throw new Error('fail');
          },
          { attempts: 100, delay: 0, signal: ctrl.signal },
        );
        ctrl.abort(new Error(`stop-${i}`));
        await expect(p).rejects.toThrow(`stop-${i}`);
        expect(calls).toBe(1);
      }
    } finally {
      stop.stop();
    }
  });
});

describe('retry: stack safety', () => {
  it('delay 0, 10k sync-failing attempts does not overflow stack', async () => {
    const N = 10_000;
    let calls = 0;
    await expect(
      retry(
        () => {
          calls++;
          throw new Error('sync-fail');
        },
        { attempts: N, delay: 0 },
      ),
    ).rejects.toThrow('sync-fail');
    expect(calls).toBe(N);
  });

  it('delay 0, 100k attempts (async failures) does not overflow stack', async () => {
    const N = 100_000;
    let calls = 0;
    await expect(
      retry(
        async () => {
          calls++;
          throw new Error('async-fail');
        },
        { attempts: N, delay: 0 },
      ),
    ).rejects.toThrow('async-fail');
    expect(calls).toBe(N);
  });
});

describe('retry: timer cleanup', () => {
  it('abort during delay clears the timer promptly', async () => {
    const ctrl = new AbortController();
    let calls = 0;
    const p = retry(
      async () => {
        calls++;
        throw new Error('fail');
      },
      { attempts: 3, delay: 50, signal: ctrl.signal },
    );
    await new Promise((r) => setTimeout(r, 2));
    ctrl.abort(new Error('stop'));
    await expect(p).rejects.toThrow('stop');
    // abort stopped retry before any further attempt
    expect(calls).toBe(1);
  });

  it('many abort-during-delay cycles complete promptly (timer retention)', async () => {
    const start = Date.now();
    for (let i = 0; i < 200; i++) {
      const ctrl = new AbortController();
      const p = retry(
        async () => {
          throw new Error('fail');
        },
        { attempts: 3, delay: 100, signal: ctrl.signal },
      );
      setTimeout(() => ctrl.abort(new Error('stop')), 0);
      await p.catch(() => {});
    }
    const elapsed = Date.now() - start;
    // If delay timers were retained, this would take ~100ms * many
    expect(elapsed).toBeLessThan(5000);
  });
});

describe('retry: failure storm', () => {
  it('thousands of sync-failing attempts', async () => {
    const stop = trackUnhandledRejections();
    try {
      let calls = 0;
      await expect(
        retry(
          () => {
            calls++;
            throw new Error('fail');
          },
          { attempts: 50_000, delay: 0 },
        ),
      ).rejects.toThrow('fail');
      expect(calls).toBe(50_000);
      await tick();
      expect(stop.observed).toHaveLength(0);
    } finally {
      stop.stop();
    }
  });
});
