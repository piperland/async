// PIPER ASYNC — race benchmark.
// Semantic equivalence: Piper strong race (first settled → cancel losers →
// await all teardown → settle) is NOT equivalent to Promise.race (returns
// immediately, losers leak/continue). We compare against a MANUAL strong-race
// baseline implementing the same semantics, and show Promise.race separately
// as the raw platform floor with a semantic caveat.

import { race } from '../dist/index.js';
import { createBench, runBench } from './helpers/harness.mjs';

// Manual strong race: first settled → cancel losers → await teardown.
async function manualStrongRace(workers) {
  const controller = new AbortController();
  const promises = workers.map((w) => Promise.resolve().then(() => w(controller.signal)));
  promises.forEach((p) => p.catch(() => {}));
  const first = await Promise.race(
    promises.map((p) => p.then(
      (v) => ({ kind: 'value', v }),
      (e) => ({ kind: 'error', e }),
    )),
  );
  controller.abort(new Error('lost'));
  await Promise.allSettled(promises);
  if (first.kind === 'value') return first.v;
  throw first.e;
}

// Cooperative losers that reject on abort (fast teardown).
function cooperativeLosers(n) {
  return Array.from({ length: n }, (_, i) => async (signal) => {
    if (i === 0) return 'winner';
    await new Promise((_r, rej) => {
      signal.addEventListener('abort', () => rej(signal.reason), { once: true });
      setTimeout(() => {}, 5);
    });
    throw signal.reason;
  });
}

async function raceSmall() {
  const bench = createBench();
  const workers2 = cooperativeLosers(2);
  bench.add('piper race 2 cooperative', async () => {
    await race(workers2);
  });
  bench.add('manual strong race 2', async () => {
    await manualStrongRace(workers2);
  });
  bench.add('Promise.race 2 (floor, leaks losers)', async () => {
    await Promise.race(workers2.map((w) => Promise.resolve().then(() => w(new AbortController().signal))));
  });
  await runBench(bench, 'race A all settle cooperatively');
}

async function raceSizes() {
  const bench = createBench();
  for (const n of [8, 32, 128]) {
    const workers = cooperativeLosers(n);
    bench.add(`piper race ${n}`, async () => {
      await race(workers);
    });
    bench.add(`manual strong race ${n}`, async () => {
      await manualStrongRace(workers);
    });
  }
  await runBench(bench, 'race C sizes');
}

async function raceRejecting() {
  const bench = createBench();
  const workers = [
    async () => {
      throw new Error('reject-winner');
    },
    ...cooperativeLosers(3).slice(1),
  ];
  bench.add('piper race rejecting winner', async () => {
    try {
      await race(workers);
    } catch {
      // expected
    }
  });
  bench.add('manual strong race rejecting', async () => {
    try {
      await manualStrongRace(workers);
    } catch {
      // expected
    }
  });
  await runBench(bench, 'race D rejecting winner');
}

await raceSmall();
await raceSizes();
await raceRejecting();
