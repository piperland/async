// PIPER ASYNC — memory/heap diagnostic benchmark.
// Run with --expose-gc: node --expose-gc bench/memory.bench.mjs
// Measures heap retention across repeated cycles per primitive.
// Diagnostic evidence (GC timing is nondeterministic), not a leak proof.

import { scope, retry, timeout, race, map } from '../dist/index.js';

async function gc() {
  for (let i = 0; i < 5; i++) {
    globalThis.gc?.();
    await new Promise((r) => setTimeout(r, 1));
  }
}

async function heap() {
  await gc();
  return process.memoryUsage().heapUsed;
}

const CYCLES = 5;
const N = 20_000;

const scenarios = {
  scope: async (n) => {
    for (let i = 0; i < n; i++) await scope(async (s) => s.spawn(() => i));
  },
  retry: async (n) => {
    for (let i = 0; i < n; i++) await retry(async () => 'ok', { attempts: 1 });
  },
  timeout: async (n) => {
    for (let i = 0; i < n; i++) await timeout(async () => 'ok', 1000);
  },
  race: async (n) => {
    for (let i = 0; i < n; i++) await race([async () => 'a', async () => 'b']);
  },
  map: async (n) => {
    await map(Array.from({ length: n }, (_, i) => i), async (x) => x, { concurrency: 8 });
  },
};

for (const [name, fn] of Object.entries(scenarios)) {
  const baseline = await heap();
  const measurements = [];
  for (let c = 0; c < CYCLES; c++) {
    await fn(N);
    measurements.push(await heap());
  }
  const first = measurements[0];
  const last = measurements[measurements.length - 1];
  const growth = last - first;
  const ratio = first === 0 ? 0 : last / first;
  console.log(
    `${name.padEnd(8)} baseline=${(baseline / 1e6).toFixed(1)}MB first=${(first / 1e6).toFixed(1)}MB last=${(last / 1e6).toFixed(1)}MB growth=${(growth / 1e6).toFixed(2)}MB ratio=${ratio.toFixed(3)}`,
  );
}
console.log('\nratio ~1.0 across cycles = no monotonic retention.');
