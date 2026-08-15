// Piper Async — consumer fixture: TypeScript strict mode.
// Compiles against the package's public types (.d.ts) under strict settings.
// Run: npx tsc --strict --noEmit --module nodenext --moduleResolution nodenext test/consumers/typescript-strict.ts

import type { Scope } from '@piperland/async';
import { map, race, retry, scope, timeout } from '@piperland/async';

// Helper typed with the public Scope type.
async function startWorkers(s: Scope): Promise<number> {
  const a = s.spawn(async () => 1);
  const b = s.spawn(() => 2);
  return (await a) + (await b);
}

// 1. scope with spawn; Scope type is importable
const scopeResult: number = await scope(async (s) => {
  return startWorkers(s);
});

// 2. retry: zero-arg + signal-aware workers both type-check
const r1: string = await retry(async () => 'ok', { attempts: 3 });
const r2: number = await retry(
  (signal) => Promise.resolve(signal.aborted ? 0 : 1),
  { attempts: 3, signal: new AbortController().signal },
);

// 3. timeout
const t1: string = await timeout(async () => 'fast', 1000);
const t2: number = await timeout(
  (signal) => Promise.resolve(signal.aborted ? 0 : 1),
  100,
);

// 4. race: heterogeneous workers infer a union
const raceVal: string | number = await race([async () => 'a', async () => 1]);

// 5. map: (item), (item, index), (item, index, signal) all assign
const m1: number[] = await map([1, 2, 3], (x) => x * 2, { concurrency: 2 });
const m2: string[] = await map(['a', 'b'], (x, i) => x + i, { concurrency: 1 });
const m3: boolean[] = await map(
  [1, 2],
  (x, i, signal) => x > 0 && i >= 0 && !signal.aborted,
  { concurrency: 2 },
);

// 6. Eager promise is a compile error (must be a lazy worker)
// @ts-expect-error - an already-started Promise is not a worker
await retry(Promise.resolve(1));

// 7. Option types are NOT public — asserted by the package's own type tests
// (test/types.test.ts). This consumer fixture focuses on positive usability.

console.log({ scopeResult, r1, r2, t1, t2, raceVal, m1, m2, m3 });
