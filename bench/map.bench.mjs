// PIPER ASYNC — map benchmark.
// Imports BUILT package + competitors (dev-deps).
// Semantic equivalence notes:
//  - Piper map is lazy (bounded pull), p-map + p-limit+Promise.all eagerly
//    materialize jobs for finite arrays. For FINITE-ARRAY throughput this is
//    an apples-ish comparison; for lazy/huge iterables the structural
//    difference is called out separately.
//  - p-map rejects on first error but does NOT cancel running workers (its
//    contract). Piper cancels + awaits teardown. Failure scenarios are
//    BEHAVIORAL-COST comparisons.

import { map as piperMap } from '../dist/index.js';
import pMap from 'p-map';
import pLimit from 'p-limit';
import { createBench, runBench } from './helpers/harness.mjs';

function makeItems(n) {
  return Array.from({ length: n }, (_, i) => i);
}

function sum(arr) {
  let s = 0;
  for (const x of arr) s += x;
  return s;
}

// ---- Map A: sync tiny worker ----
async function mapSyncWorker(items) {
  const bench = createBench();
  for (const n of [1000, 10_000]) {
    const input = makeItems(n);
    bench.add(`piper map sync n=${n} c=4`, async () => {
      const r = await piperMap(input, (x) => x + 1, { concurrency: 4 });
      return sum(r);
    });
    bench.add(`p-map sync n=${n} c=4`, async () => {
      const r = await pMap(input, (x) => x + 1, { concurrency: 4 });
      return sum(r);
    });
    bench.add(`p-limit+all sync n=${n} c=4`, async () => {
      const limit = pLimit(4);
      const r = await Promise.all(input.map((x) => limit(() => x + 1)));
      return sum(r);
    });
    bench.add(`Promise.all sync n=${n}`, async () => {
      const r = await Promise.all(input.map((x) => x + 1));
      return sum(r);
    });
  }
  await runBench(bench, `map sync worker ${items}`);
}

// ---- Map B: immediately-resolved async worker ----
async function mapAsyncWorker() {
  const bench = createBench();
  const n = 10_000;
  const input = makeItems(n);
  bench.add('piper map async n=10k c=4', async () => {
    const r = await piperMap(input, async (x) => x + 1, { concurrency: 4 });
    return sum(r);
  });
  bench.add('p-map async n=10k c=4', async () => {
    const r = await pMap(input, async (x) => x + 1, { concurrency: 4 });
    return sum(r);
  });
  bench.add('p-limit+all async n=10k c=4', async () => {
    const limit = pLimit(4);
    const r = await Promise.all(input.map((x) => limit(async () => x + 1)));
    return sum(r);
  });
  await runBench(bench, 'map async worker');
}

// ---- Map C: one-microtask worker ----
async function mapMicrotaskWorker() {
  const bench = createBench();
  const n = 5000;
  const input = makeItems(n);
  const yieldMicro = () => new Promise((r) => queueMicrotask(r));
  bench.add('piper map microtask n=5k c=4', async () => {
    const r = await piperMap(input, async (x) => {
      await yieldMicro();
      return x + 1;
    }, { concurrency: 4 });
    return sum(r);
  });
  bench.add('p-map microtask n=5k c=4', async () => {
    const r = await pMap(input, async (x) => {
      await yieldMicro();
      return x + 1;
    }, { concurrency: 4 });
    return sum(r);
  });
  await runBench(bench, 'map microtask worker');
}

// ---- Map E: async iterable (structural note) ----
async function mapAsyncIterable() {
  const bench = createBench();
  const n = 5000;
  async function* lazyInput() {
    for (let i = 0; i < n; i++) yield i;
  }
  bench.add('piper map async-iterable n=5k c=4 (lazy)', async () => {
    const r = await piperMap(lazyInput(), async (x) => x + 1, { concurrency: 4 });
    return sum(r);
  });
  // p-map accepts async iterables too (documented); compare directly.
  bench.add('p-map async-iterable n=5k c=4', async () => {
    const r = await pMap(lazyInput(), async (x) => x + 1, { concurrency: 4 });
    return sum(r);
  });
  await runBench(bench, 'map async iterable');
}

// ---- Map scale: concurrency sweep ----
async function mapConcurrencySweep() {
  const bench = createBench();
  const n = 20_000;
  const input = makeItems(n);
  for (const c of [1, 8, 64, Infinity]) {
    const label = c === Infinity ? 'Inf' : String(c);
    bench.add(`piper map n=20k c=${label}`, async () => {
      const r = await piperMap(input, async (x) => x + 1, { concurrency: c });
      return sum(r);
    });
  }
  await runBench(bench, 'map concurrency sweep');
}

// ---- Map F: failure (BEHAVIORAL-COST) ----
async function mapFailure() {
  // Measure time-to-teardown + items started for a failing map.
  // Piper cancels + awaits teardown of started workers; p-map does NOT cancel
  // running workers (rejects as soon as the failing item settles).
  console.log('\n=== map failure (behavioral) ===');
  for (const impl of ['piper', 'p-map']) {
    const input = makeItems(200);
    let started = 0;
    const t0 = performance.now();
    let rejected = false;
    try {
      if (impl === 'piper') {
        await piperMap(input, async (x) => {
          started++;
          if (x === 50) throw new Error('fail');
          await new Promise((r) => setTimeout(r, 1));
          return x;
        }, { concurrency: 8 });
      } else {
        await pMap(input, async (x) => {
          started++;
          if (x === 50) throw new Error('fail');
          await new Promise((r) => setTimeout(r, 1));
          return x;
        }, { concurrency: 8 });
      }
    } catch {
      rejected = true;
    }
    const dt = performance.now() - t0;
    console.log(`  ${impl}: rejected=${rejected} started=${started} settleTime=${dt.toFixed(1)}ms`);
  }
}

await mapSyncWorker();
await mapAsyncWorker();
await mapMicrotaskWorker();
await mapAsyncIterable();
await mapConcurrencySweep();
await mapFailure();
