// Provider failover with `any`: the PRIMARY fails quickly, a REPLICA succeeds,
// the SLOW provider is cancelled. First SUCCESS wins; the slow loser observes
// cancellation and is awaited to teardown before `any()` settles.
//
// Run:  node examples/provider-failover.mjs

import { any } from '@piperland/async';

// A deterministic provider: succeeds/fails after a delay, honors cancellation.
function provider(name, { delay, fail, cleanupMs = 5 }) {
  return (signal) =>
    new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        if (fail) reject(new Error(`${name} down`));
        else resolve(`${name}-data`);
      }, delay);
      signal.addEventListener(
        'abort',
        () => {
          clearTimeout(timer);
          // simulate cleanup (e.g. closing a connection)
          setTimeout(() => reject(signal.reason), cleanupMs);
        },
        { once: true },
      );
    });
}

// Primary fails quickly; replica succeeds at 40ms; slow provider would take 500ms.
const winner = await any([
  provider('primary', { delay: 10, fail: true }),
  provider('replica', { delay: 40 }),
  provider('slow', { delay: 500 }),
]);

console.log('first success:', winner); // replica-data
console.log('(slow provider was cancelled and its teardown awaited before any() settled)');
