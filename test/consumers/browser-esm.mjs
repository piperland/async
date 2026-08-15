// Piper Async — consumer fixture: browser-style ESM.
// Uses ONLY the public package entry point, written as a browser consumer
// would (no Node APIs). This is a module a browser page could import.
// Run via the Playwright browser runner OR directly under Node (both work).

import { map, race, retry, scope, timeout } from '@piperland/async';

const results = [];
const check = (name, cond) => results.push({ name, ok: Boolean(cond) });

async function main() {
  // scope + spawn
  await scope(async (s) => {
    const v = await s.spawn(async () => 42);
    check('browser scope spawn', v === 42);
  });

  // external AbortSignal cancellation (browser pattern)
  const ctrl = new AbortController();
  const reason = new Error('user-cancel');
  const p = scope(
    async (s) => {
      await new Promise((_r, rej) => {
        s.signal.addEventListener('abort', () => rej(s.signal.reason), {
          once: true,
        });
      });
      return 'never';
    },
    { signal: ctrl.signal },
  );
  ctrl.abort(reason);
  const err = await p.then(
    () => null,
    (e) => e,
  );
  check('browser external abort reason', err === reason);

  // timeout TimeoutError
  const terr = await timeout(async (signal) => {
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
  check('browser timeout TimeoutError', terr?.name === 'TimeoutError');

  // retry parent abort
  const rctrl = new AbortController();
  let rcalls = 0;
  const rp = retry(
    async (signal) => {
      rcalls++;
      // first attempt waits briefly so the parent abort lands mid-attempt
      await new Promise((_r, rej) => {
        signal.addEventListener('abort', () => rej(signal.reason), {
          once: true,
        });
        setTimeout(() => rej(new Error('fail')), 30);
      });
      return 'never';
    },
    { attempts: 5, signal: rctrl.signal },
  ).then(
    () => null,
    (e) => e,
  );
  setTimeout(() => rctrl.abort(new Error('stop')), 5);
  const rerr = await rp;
  check('browser retry parent abort', rerr?.message === 'stop' && rcalls === 1);

  // race loser teardown
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
  check('browser race winner', winner === 'winner');
  check('browser race loser teardown', loserCleaned);

  // map concurrency
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
  check('browser map concurrency bounded', maxActive <= 3);

  return results;
}

export { main };
