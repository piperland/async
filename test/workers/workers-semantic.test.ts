// PIPER ASYNC — Cloudflare Workers semantic validation.
// Runs the BUILT/public API inside a real workerd runtime via
// @cloudflare/vitest-pool-workers. This is the official Cloudflare Vitest
// integration (NOT raw Miniflare constructor internals).
//
// Note: this test imports the BUILT package output (../../dist/index.js) so it
// validates what a Workers consumer would actually receive.

import { describe, expect, it } from 'vitest';
// eslint-disable-next-line @typescript-eslint/consistent-type-imports -- import type from dist
import type { Scope } from '../../dist/index.js';
import { map, race, retry, scope, timeout } from '../../dist/index.js';

describe('piper in cloudflare workers (workerd)', () => {
  it('scope spawn returns value', async () => {
    await scope(async (s: Scope) => {
      const v = await s.spawn(async () => 42);
      expect(v).toBe(42);
    });
  });

  it('scope child failure cancels sibling', async () => {
    let siblingCancelled = false;
    try {
      await scope(async (s) => {
        s.spawn(async (signal) => {
          await new Promise((_r, rej) => {
            signal.addEventListener(
              'abort',
              () => {
                siblingCancelled = true;
                rej(signal.reason);
              },
              { once: true },
            );
          });
        });
        s.spawn(async () => {
          throw new Error('fail-one');
        });
        await new Promise((r) => setTimeout(r, 5));
      });
    } catch {
      expect(siblingCancelled).toBe(true);
    }
  });

  it('timeout rejects with TimeoutError', async () => {
    const err = await timeout(async (signal) => {
      await new Promise((_r, rej) => {
        signal.addEventListener('abort', () => rej(signal.reason), {
          once: true,
        });
      });
      return 'never';
    }, 10).then(
      () => null,
      (e) => e,
    );
    expect(err?.name).toBe('TimeoutError');
  });

  it('DOMException and AbortSignal.any behave', async () => {
    expect(typeof DOMException).toBe('function');
    const a1 = new AbortController();
    const a2 = new AbortController();
    const anySig = AbortSignal.any([a1.signal, a2.signal]);
    a2.abort(new Error('any-err'));
    expect(anySig.reason?.message).toBe('any-err');
  });

  it('retry stops on parent abort', async () => {
    const ctrl = new AbortController();
    let calls = 0;
    const p = retry(
      async (signal) => {
        calls++;
        // first attempt waits briefly so the parent abort lands mid-attempt
        await new Promise((_r, rej) => {
          signal.addEventListener('abort', () => rej(signal.reason), {
            once: true,
          });
          setTimeout(() => rej(new Error('fail')), 30);
        });
        return 'never';
      },
      { attempts: 5, signal: ctrl.signal },
    ).then(
      () => null,
      (e) => e,
    );
    setTimeout(() => ctrl.abort(new Error('stop')), 5);
    const err = await p;
    expect(err?.message).toBe('stop');
    expect(calls).toBe(1);
  });

  it('race waits loser teardown', async () => {
    let loserCleaned = false;
    const winner = await race([
      async () => 'winner',
      async (signal) => {
        try {
          await new Promise((_r, rej) => {
            signal.addEventListener('abort', () => rej(signal.reason), {
              once: true,
            });
          });
          return 'loser';
        } catch {
          loserCleaned = true;
          throw signal.reason;
        }
      },
    ]);
    expect(winner).toBe('winner');
    expect(loserCleaned).toBe(true);
  });

  it('map bounds concurrency', async () => {
    let active = 0;
    let maxActive = 0;
    await map(
      Array.from({ length: 20 }, (_, i) => i),
      async (x) => {
        active++;
        maxActive = Math.max(maxActive, active);
        await new Promise((r) => setTimeout(r, 1));
        active--;
        return x;
      },
      { concurrency: 3 },
    );
    expect(maxActive).toBeLessThanOrEqual(3);
  });
});
