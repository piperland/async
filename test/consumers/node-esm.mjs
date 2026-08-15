// Piper Async — consumer fixture: vanilla Node ESM.
// Uses ONLY the public package entry point (as a consumer would).
// Run against the BUILT output.

import { map, race, retry, scope, timeout } from '@piperland/async';

const assert = (cond, name) => {
  if (!cond) throw new Error(`fixture FAIL: ${name}`);
  console.log(`  ok: ${name}`);
};

// 1. Sequential scope — no spawn needed
const user = await scope(async () => {
  const u = { id: 1 };
  return u;
});
assert(user.id === 1, 'scope sequential');

// 2. Concurrent children via spawn
const combined = await scope(async (s) => {
  const a = s.spawn(async () => 1);
  const b = s.spawn(async () => 2);
  return (await a) + (await b);
});
assert(combined === 3, 'scope spawn concurrent');

// 3. retry fail-then-success
let calls = 0;
const retried = await retry(
  async () => {
    calls++;
    if (calls < 2) throw new Error('transient');
    return 'ok';
  },
  { attempts: 3 },
);
assert(retried === 'ok' && calls === 2, 'retry fail-then-success');

// 4. timeout success
const timed = await timeout(async () => 'fast', 1000);
assert(timed === 'fast', 'timeout success');

// 5. race winner
const raced = await race([async () => 'a', async () => 'b']);
assert(['a', 'b'].includes(raced), 'race winner');

// 6. map bounded
const mapped = await map([1, 2, 3], (x) => x * 2, { concurrency: 2 });
assert(JSON.stringify(mapped) === '[2,4,6]', 'map ordered');

console.log('consumer-fixture node-esm: all passed');
