// PIPER ASYNC — runtime-neutral semantic parity fixture.
// Runs under Node / Bun / Deno / browser WITHOUT Vitest.
// Usage: node test/runtime-parity.mjs  (or bun/deno)
// Imports the BUILT package entry point so it validates consumer-facing output.
//
// Checks the essential invariants across runtimes:
//   scope owns child / child failure cancels sibling
//   timeout cleans up
//   retry stops on parent abort
//   race waits loser teardown
//   any returns first success / AggregateError on all-fail
//   map bounds concurrency

import { any, map, race, retry, scope, timeout } from '../dist/index.js';

let passed = 0;
let failed = 0;
const failures = [];

function assert(cond, name) {
  if (cond) {
    passed++;
    console.log(`  ok: ${name}`);
  } else {
    failed++;
    failures.push(name);
    console.log(`  FAIL: ${name}`);
  }
}

async function main() {
  console.log(
    'runtime parity:',
    typeof process !== 'undefined'
      ? `node-like ${process.version ?? ''}`
      : 'browser-like',
  );

  // scope owns a child
  await scope(async (s) => {
    const v = await s.spawn(async () => 42);
    assert(v === 42, 'scope spawn returns value');
  });

  // scope child failure cancels sibling
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
  } catch (e) {
    assert(
      String(e?.message ?? e).includes('fail-one'),
      'scope rejects with child error',
    );
  }
  assert(siblingCancelled, 'scope cancels sibling on child failure');

  // timeout cleans up
  const timeoutErr = await timeout(async (signal) => {
    await new Promise((_r, rej) => {
      signal.addEventListener('abort', () => rej(signal.reason), {
        once: true,
      });
    });
    return 'never';
  }, 5).then(
    () => null,
    (e) => e,
  );
  assert(
    timeoutErr?.name === 'TimeoutError',
    'timeout rejects with TimeoutError',
  );

  // retry stops on parent abort
  const ctrl = new AbortController();
  let retryCalls = 0;
  const retryP = retry(
    async (signal) => {
      retryCalls++;
      if (retryCalls === 1) {
        // first attempt waits briefly; abort lands during it
        await new Promise((_r, rej) => {
          signal.addEventListener('abort', () => rej(signal.reason), {
            once: true,
          });
          setTimeout(() => rej(new Error('fail')), 30);
        });
        return 'never';
      }
      throw new Error('should-not-reach');
    },
    { attempts: 5, signal: ctrl.signal },
  ).then(
    () => null,
    (e) => e,
  );
  // abort while attempt 1 is still running
  setTimeout(() => ctrl.abort(new Error('stop')), 5);
  const retryErr = await retryP;
  assert(
    retryErr?.message === 'stop',
    'retry rejects with parent abort reason',
  );
  assert(retryCalls === 1, 'retry did not start a new attempt after abort');

  // race waits loser teardown
  let loserCleaned = false;
  const winner = await race([
    async () => 'winner',
    async (signal) => {
      try {
        await new Promise((_r, rej) => {
          signal.addEventListener('abort', () => rej(signal.reason), {
            once: true,
          });
          setTimeout(() => {}, 20);
        });
        return 'loser';
      } catch {
        loserCleaned = true;
        throw signal.reason;
      }
    },
  ]);
  assert(winner === 'winner', 'race returns winner');
  assert(loserCleaned, 'race waits for loser teardown');

  // any returns first SUCCESS even when a faster candidate rejects
  let anyLoserCancelled = false;
  const anyWinner = await any([
    async () => {
      await new Promise((r) => setTimeout(r, 5));
      throw new Error('fast-fail');
    },
    async () => {
      await new Promise((r) => setTimeout(r, 20));
      return 'second-success';
    },
    async (signal) => {
      await new Promise((_r, rej) => {
        signal.addEventListener(
          'abort',
          () => {
            anyLoserCancelled = true;
            rej(signal.reason);
          },
          { once: true },
        );
        setTimeout(() => {}, 200);
      });
      return 'slow-loser';
    },
  ]);
  assert(
    anyWinner === 'second-success',
    'any returns first success after a rejection',
  );
  assert(
    anyLoserCancelled,
    'any cancels the slow loser after a success is selected',
  );

  // any all-fail -> AggregateError
  const anyErr = await any([
    async () => {
      throw 'one';
    },
    async () => {
      throw 2;
    },
  ]).then(
    () => null,
    (e) => e,
  );
  assert(
    anyErr instanceof AggregateError,
    'any all-fail rejects with AggregateError',
  );
  assert(
    Array.isArray(anyErr?.errors) &&
      anyErr.errors[0] === 'one' &&
      anyErr.errors[1] === 2,
    'any AggregateError preserves reasons in input order',
  );

  // map bounds concurrency
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
  assert(maxActive <= 3, `map bounds concurrency (maxActive=${maxActive})`);

  console.log(`\nparity: ${passed} passed, ${failed} failed`);
  if (failed > 0) {
    console.log('failures:', failures.join(', '));
    process.exitCode = 1;
  }
}

main().catch((e) => {
  console.error('parity crashed:', e);
  process.exit(1);
});
