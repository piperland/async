import { describe, expect, it } from 'vitest';
import { retry } from '../src/retry.js';

describe('retry', () => {
  it('success on first attempt', async () => {
    let calls = 0;
    const r = await retry(async () => {
      calls++;
      return 'ok';
    });
    expect(calls).toBe(1);
    expect(r).toBe('ok');
  });

  it('fail then success', async () => {
    let calls = 0;
    const r = await retry(async () => {
      calls++;
      if (calls === 1) throw new Error('first-fail');
      return 'ok';
    });
    expect(calls).toBe(2);
    expect(r).toBe('ok');
  });

  it('exhaust attempts rejects', async () => {
    let calls = 0;
    await expect(
      retry(
        async () => {
          calls++;
          throw new Error('always-fail');
        },
        { attempts: 3 },
      ),
    ).rejects.toThrow('always-fail');
    expect(calls).toBe(3);
  });

  it('attempts 1 means no retry', async () => {
    let calls = 0;
    await expect(
      retry(
        async () => {
          calls++;
          throw new Error('fail');
        },
        { attempts: 1 },
      ),
    ).rejects.toThrow('fail');
    expect(calls).toBe(1);
  });

  it('default attempts is 3', async () => {
    let calls = 0;
    await expect(
      retry(async () => {
        calls++;
        throw new Error('fail');
      }),
    ).rejects.toThrow('fail');
    expect(calls).toBe(3);
  });

  it('fixed delay between failed attempts', async () => {
    let calls = 0;
    const start = Date.now();
    await expect(
      retry(
        async () => {
          calls++;
          throw new Error('fail');
        },
        { attempts: 2, delay: 20 },
      ),
    ).rejects.toThrow('fail');
    expect(Date.now() - start).toBeGreaterThanOrEqual(15);
    expect(calls).toBe(2);
  });

  it('parent abort before start stops retrying', async () => {
    const ctrl = new AbortController();
    const cause = new Error('stop');
    ctrl.abort(cause);
    let calls = 0;
    await expect(
      retry(
        async () => {
          calls++;
          return 'never';
        },
        { attempts: 3, signal: ctrl.signal },
      ),
    ).rejects.toBe(cause);
    expect(calls).toBe(0);
  });

  it('parent abort during worker stops retrying', async () => {
    const ctrl = new AbortController();
    let calls = 0;
    const p = retry(
      async (signal) => {
        calls++;
        await new Promise((_r, rej) => {
          signal.addEventListener('abort', () => rej(signal.reason));
          setTimeout(() => {}, 50);
        });
        return 'never';
      },
      { attempts: 3, signal: ctrl.signal },
    );
    ctrl.abort(new Error('mid-stop'));
    await expect(p).rejects.toThrow('mid-stop');
    expect(calls).toBe(1);
  });

  it('parent abort during delay stops retrying', async () => {
    const ctrl = new AbortController();
    let calls = 0;
    const p = retry(
      async () => {
        calls++;
        throw new Error('fail');
      },
      { attempts: 3, delay: 30, signal: ctrl.signal },
    );
    setTimeout(() => ctrl.abort(new Error('stop-delay')), 5);
    await expect(p).rejects.toThrow('stop-delay');
    expect(calls).toBe(1);
  });

  it('ordinary AbortError while parent NOT aborted is retryable', async () => {
    let calls = 0;
    const r = await retry(async () => {
      calls++;
      if (calls === 1) throw new DOMException('aborted', 'AbortError');
      return 'ok';
    });
    expect(calls).toBe(2);
    expect(r).toBe('ok');
  });

  it('per-attempt TimeoutError (own signal) is retryable', async () => {
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

  it('invalid attempts: 0', () => {
    expect(() => retry(async () => 1, { attempts: 0 })).toThrow(RangeError);
  });

  it('invalid attempts: negative', () => {
    expect(() => retry(async () => 1, { attempts: -2 })).toThrow(RangeError);
  });

  it('invalid attempts: NaN', () => {
    expect(() => retry(async () => 1, { attempts: Number.NaN })).toThrow(
      RangeError,
    );
  });

  it('invalid attempts: Infinity', () => {
    expect(() =>
      retry(async () => 1, { attempts: Number.POSITIVE_INFINITY }),
    ).toThrow(RangeError);
  });

  it('invalid attempts: fractional', () => {
    expect(() => retry(async () => 1, { attempts: 2.5 })).toThrow(RangeError);
  });

  it('invalid delay: negative', () => {
    expect(() => retry(async () => 1, { attempts: 2, delay: -1 })).toThrow(
      RangeError,
    );
  });

  it('invalid delay: NaN', () => {
    expect(() =>
      retry(async () => 1, { attempts: 2, delay: Number.NaN }),
    ).toThrow(RangeError);
  });

  it('sync throw in worker is retryable', async () => {
    let calls = 0;
    await expect(
      retry(
        () => {
          calls++;
          throw new Error('sync-fail');
        },
        { attempts: 2 },
      ),
    ).rejects.toThrow('sync-fail');
    expect(calls).toBe(2);
  });

  it('sync return in worker', async () => {
    await expect(retry(() => 'sync-ok')).resolves.toBe('sync-ok');
  });

  it('rejects non-function worker', () => {
    // @ts-expect-error testing runtime validation
    expect(() => retry(null)).toThrow(TypeError);
  });
});
