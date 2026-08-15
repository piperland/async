// Piper Async — consumer fixture: realistic composition.
// A realistic app-style composition using ONLY the public API: a scope that
// fans out N parallel requests with per-item timeout + retry, then races two
// providers, all bounded by a map. This is what a real developer would write.

import { map, race, retry, scope, timeout } from '@piperland/async';

const assert = (cond, name) => {
  if (!cond) throw new Error(`fixture FAIL: ${name}`);
  console.log(`  ok: ${name}`);
};

// Simulated fetches (no real network).
const fetchUser = async (id, signal) => {
  await new Promise((r, rej) => {
    signal.addEventListener('abort', () => rej(signal.reason), { once: true });
    setTimeout(r, 1);
  });
  return { id, name: `user-${id}` };
};

const PROVIDERS = [
  async (signal) => {
    await new Promise((r, rej) => {
      signal.addEventListener('abort', () => rej(signal.reason), {
        once: true,
      });
      setTimeout(r, 15);
    });
    return 'provider-a';
  },
  async (signal) => {
    await new Promise((r, rej) => {
      signal.addEventListener('abort', () => rej(signal.reason), {
        once: true,
      });
      setTimeout(r, 3);
    });
    return 'provider-b';
  },
];

// Realistic app: load 100 users with concurrency 10, each with a timeout,
// then race two providers for the best source, all inside one scope.
let attempts = 0;
const app = await scope(async (s) => {
  // Map with bounded concurrency, per-item timeout, owned by the scope.
  const users = await map(
    Array.from({ length: 100 }, (_, i) => i + 1),
    (id) =>
      timeout((signal) => fetchUser(id, signal), 500, {
        signal: s.signal,
      }),
    { concurrency: 10, signal: s.signal },
  );

  // Race two providers for the best source.
  const provider = await race(PROVIDERS, { signal: s.signal });

  // Retry a flaky enrichment.
  const enriched = await retry(
    async () => {
      attempts++;
      if (attempts < 3) throw new Error('flaky');
      return 'enriched';
    },
    { attempts: 5, signal: s.signal },
  );

  return { users, provider, enriched };
});

assert(app.users.length === 100, 'composition: 100 users loaded');
assert(app.users[0].name === 'user-1', 'composition: user data correct');
assert(
  app.provider === 'provider-b',
  'composition: race picked faster provider',
);
assert(
  app.enriched === 'enriched' && attempts === 3,
  'composition: retry succeeded',
);
console.log('consumer-fixture realistic-composition: all passed');
