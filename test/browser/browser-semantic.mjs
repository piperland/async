// PIPER ASYNC — browser semantic validation (executed in real Chromium).
// Imports the BUILT package entry point (dist/index.js) — validates that a
// browser consumer works with the published output, not src/ internals.
// Run via test/browser/run-browser-test.mjs (Playwright + headless Chromium).

import { scope, retry, timeout, race, map } from '../../dist/index.js';

const results = [];
function check(name, cond, extra = '') {
  results.push({ name, ok: Boolean(cond), extra: String(extra) });
}

async function main() {
  // scope spawn returns value
  await scope(async (s) => {
    const v = await s.spawn(async () => 42);
    check('scope:spawn-returns-value', v === 42);
  });

  // scope child failure cancels sibling (AbortSignal propagation)
  let siblingCancelled = false;
  try {
    await scope(async (s) => {
      s.spawn(async (signal) => {
        await new Promise((_r, rej) => {
          signal.addEventListener('abort', () => {
            siblingCancelled = true;
            rej(signal.reason);
          }, { once: true });
        });
      });
      s.spawn(async () => {
        throw new Error('fail-one');
      });
      await new Promise((r) => setTimeout(r, 5));
    });
  } catch {
    check('scope:child-failure-cancels-sibling', siblingCancelled);
  }

  // external AbortSignal cancellation
  const ctrl = new AbortController();
  const reason = new Error('browser-cancel');
  const scopeP = scope(
    async (s) => {
      await new Promise((_r, rej) => {
        s.signal.addEventListener('abort', () => rej(s.signal.reason), { once: true });
      });
      return 'never';
    },
    { signal: ctrl.signal },
  );
  ctrl.abort(reason);
  const scopeErr = await scopeP.then(() => null, (e) => e);
  check('scope:external-abort-reason', scopeErr === reason);

  // timeout rejects with TimeoutError
  const timeoutErr = await timeout(async (signal) => {
    await new Promise((_r, rej) => {
      signal.addEventListener('abort', () => rej(signal.reason), { once: true });
    });
    return 'never';
  }, 10).then(() => null, (e) => e);
  check('timeout:TimeoutError', timeoutErr?.name === 'TimeoutError');

  // DOMException behavior
  check('dom:DOMException-global', typeof DOMException === 'function');
  check('dom:TimeoutError-name', timeoutErr?.name === 'TimeoutError');

  // AbortSignal.any behavior
  const a1 = new AbortController();
  const a2 = new AbortController();
  const anySig = AbortSignal.any([a1.signal, a2.signal]);
  a2.abort(new Error('any-err'));
  check('abortsignal:any-reason', anySig.reason?.message === 'any-err');

  // retry stops on parent abort
  const retryCtrl = new AbortController();
  let retryCalls = 0;
  const retryP = retry(async (signal) => {
    retryCalls++;
    if (retryCalls === 1) {
      // first attempt waits briefly so the parent abort lands mid-attempt
      await new Promise((_r, rej) => {
        signal.addEventListener('abort', () => rej(signal.reason), { once: true });
        setTimeout(() => rej(new Error('fail')), 30);
      });
      return 'never';
    }
    throw new Error('should-not-reach');
  }, { attempts: 5, signal: retryCtrl.signal }).then(() => null, (e) => e);
  setTimeout(() => retryCtrl.abort(new Error('retry-stop')), 5);
  const retryErr = await retryP;
  check('retry:parent-abort', retryErr?.message === 'retry-stop' && retryCalls === 1);

  // race waits loser teardown
  let loserCleaned = false;
  const winner = await race([
    async () => 'winner',
    async (signal) => {
      try {
        await new Promise((_r, rej) => {
          signal.addEventListener('abort', () => rej(signal.reason), { once: true });
        });
        return 'loser';
      } catch {
        loserCleaned = true;
        throw signal.reason;
      }
    },
  ]);
  check('race:winner', winner === 'winner');
  check('race:loser-teardown', loserCleaned);

  // map bounds concurrency
  let active = 0;
  let maxActive = 0;
  await map(Array.from({ length: 20 }, (_, i) => i), async (x) => {
    active++;
    maxActive = Math.max(maxActive, active);
    await new Promise((r) => setTimeout(r, 1));
    active--;
    return x;
  }, { concurrency: 3 });
  check('map:concurrency-bounded', maxActive <= 3, `maxActive=${maxActive}`);

  const failed = results.filter((r) => !r.ok);
  console.log('BROWSER-SEMANTIC-RESULTS ' + JSON.stringify({ results, failedCount: failed.length }));
  return { ok: failed.length === 0, results };
}

export { main };
