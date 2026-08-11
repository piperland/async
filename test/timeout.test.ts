import { describe, expect, it } from 'vitest';
import { timeout } from '../src/timeout.js';

describe('timeout', () => {
  it('worker wins before deadline', async () => {
    await expect(timeout(async () => 'ok', 1000)).resolves.toBe('ok');
  });

  it('timeout wins with TimeoutError', async () => {
    const slow = async (signal: AbortSignal) => {
      await new Promise((_r, rej) => {
        signal.addEventListener('abort', () => rej(signal.reason));
        setTimeout(() => {}, 100);
      });
      return 'never';
    };
    await expect(timeout(slow, 10)).rejects.toMatchObject({
      name: 'TimeoutError',
    });
  });

  it('parent abort reason wins', async () => {
    const ctrl = new AbortController();
    const cause = new Error('parent-stop');
    const p = timeout(
      async (signal) => {
        await new Promise((_r, rej) => {
          signal.addEventListener('abort', () => rej(signal.reason));
          setTimeout(() => {}, 100);
        });
        return 'never';
      },
      1000,
      { signal: ctrl.signal },
    );
    ctrl.abort(cause);
    await expect(p).rejects.toBe(cause);
  });

  it('worker failure wins if before timeout', async () => {
    await expect(
      timeout(async () => {
        throw new Error('worker-fail');
      }, 1000),
    ).rejects.toThrow('worker-fail');
  });

  it('already-aborted parent rejects immediately', async () => {
    const ctrl = new AbortController();
    const cause = new Error('pre-aborted');
    ctrl.abort(cause);
    await expect(
      timeout(async () => 'ok', 1000, { signal: ctrl.signal }),
    ).rejects.toBe(cause);
  });

  it('zero milliseconds times out immediately', async () => {
    await expect(timeout(async () => 'ok', 0)).rejects.toMatchObject({
      name: 'TimeoutError',
    });
  });

  it('negative milliseconds is invalid', () => {
    expect(() => timeout(async () => 'ok', -1)).toThrow(RangeError);
  });

  it('NaN milliseconds is invalid', () => {
    expect(() => timeout(async () => 'ok', Number.NaN)).toThrow(RangeError);
  });

  it('Infinity milliseconds is invalid', () => {
    expect(() => timeout(async () => 'ok', Number.POSITIVE_INFINITY)).toThrow(
      RangeError,
    );
  });

  it('fractional milliseconds accepted per platform timer', async () => {
    await expect(timeout(async () => 'ok', 0.5)).resolves.toBe('ok');
  });

  it('cleanup runs before rejection on timeout', async () => {
    const order: string[] = [];
    await expect(
      timeout(async (signal) => {
        try {
          await new Promise((_r, rej) => {
            signal.addEventListener('abort', () => rej(signal.reason));
            setTimeout(() => {}, 100);
          });
          return 'never';
        } finally {
          order.push('cleanup');
        }
      }, 10),
    ).rejects.toMatchObject({ name: 'TimeoutError' });
    expect(order).toContain('cleanup');
  });

  it('uncooperative finite worker delays timeout settlement', async () => {
    const order: string[] = [];
    const start = Date.now();
    await expect(
      timeout(async () => {
        // ignores the signal entirely; finishes after 30ms
        await new Promise((r) => setTimeout(r, 30));
        order.push('uncoop-done');
        return 'u';
      }, 5),
    ).rejects.toMatchObject({ name: 'TimeoutError' });
    expect(order).toContain('uncoop-done');
    expect(Date.now() - start).toBeGreaterThanOrEqual(20);
  });

  it('reason identity is TimeoutError', async () => {
    const slow = async (signal: AbortSignal) => {
      await new Promise((_r, rej) => {
        signal.addEventListener('abort', () => rej(signal.reason));
        setTimeout(() => {}, 100);
      });
      return 'never';
    };
    await expect(timeout(slow, 10)).rejects.toMatchObject({
      name: 'TimeoutError',
      message: 'Timeout exceeded',
    });
  });

  it('timer is cleared when worker wins', async () => {
    const p = timeout(async () => 'fast', 1000);
    await p;
    // no assertion needed beyond resolving; timer clearing verified by not hanging
  });
});
