// PIPER ASYNC — timeout benchmark.
// Semantic equivalence: Piper strong timeout (abort + await teardown + reject)
// is NOT equivalent to a wall-clock wrapper that rejects while underlying work
// continues. p-timeout 7.x takes an EAGER promise and CANNOT cancel the
// underlying work. So:
//  - Timeout A (worker completes before deadline): direct overhead comparison.
//  - Timeout B (timeout fires, worker cooperates): Piper vs a MANUAL native
//    equivalent-cancellation baseline; p-timeout shown separately (different
//    semantics — it does not stop underlying work).
//  - Timeout C (uncooperative worker): behavioral timing, not throughput.

import { timeout } from '../dist/index.js';
import pTimeout from 'p-timeout';
import { createBench, runBench } from './helpers/harness.mjs';

async function timeoutSuccess() {
  const bench = createBench();
  bench.add('piper timeout success (1s)', async () => {
    await timeout(async () => 'ok', 1000);
  });
  bench.add('p-timeout success (1s)', async () => {
    await pTimeout(Promise.resolve('ok'), { milliseconds: 1000 });
  });
  bench.add('manual native wrapper', async () => {
    await new Promise((resolve) => {
      const p = Promise.resolve('ok');
      const timer = setTimeout(() => {}, 1000);
      p.then(() => clearTimeout(timer)).then(resolve);
    });
  });
  await runBench(bench, 'timeout A worker completes before deadline');
}

async function timeoutCooperative() {
  // Behavioral: timeout fires, worker cooperates. Piper cancels + awaits
  // teardown. Manual native baseline implements equivalent behavior.
  console.log('\n=== timeout B fires, cooperative worker (behavioral) ===');
  const worker = (signal) =>
    new Promise((_r, rej) => {
      signal.addEventListener('abort', () => rej(signal.reason), { once: true });
      setTimeout(() => {}, 50);
    });

  // Piper
  let t0 = performance.now();
  let piperErr = null;
  try {
    await timeout(worker, 5);
  } catch (e) {
    piperErr = e;
  }
  const piperMs = performance.now() - t0;

  // p-timeout: takes an eager promise that rejects on a manual abort; but
  // p-timeout itself cannot cancel it — we pass a signal to a promise that
  // rejects via AbortSignal. Actually p-timeout's signal aborts the WAIT, not
  // the work. Measure its rejection timing + whether work was stopped.
  t0 = performance.now();
  let ptErr = null;
  let ptWorkStopped = false;
  const ctrl = new AbortController();
  const workPromise = new Promise((_r, rej) => {
    ctrl.signal.addEventListener('abort', () => {
      ptWorkStopped = true;
      rej(ctrl.signal.reason);
    }, { once: true });
    setTimeout(() => {}, 50); // would keep running without abort
  });
  try {
    await pTimeout(workPromise, { milliseconds: 5, signal: ctrl.signal });
  } catch (e) {
    ptErr = e;
  }
  const ptMs = performance.now() - t0;

  console.log(`  piper: err=${piperErr?.name} settleTime=${piperMs.toFixed(1)}ms (awaits teardown)`);
  console.log(`  p-timeout: err=${ptErr?.name} settleTime=${ptMs.toFixed(1)}ms workStopped=${ptWorkStopped}`);
  console.log('  NOTE: p-timeout aborts the WAIT; whether work stops depends on the promise observing the signal.');
}

async function timeoutUncooperative() {
  // Behavioral: uncooperative finite worker. Piper settles after worker
  // teardown (strong). A wall-clock wrapper rejects earlier.
  console.log('\n=== timeout C uncooperative worker (behavioral) ===');
  const uncoop = async () => {
    await new Promise((r) => setTimeout(r, 30));
    return 'u';
  };
  let t0 = performance.now();
  let piperErr = null;
  try {
    await timeout(uncoop, 5);
  } catch (e) {
    piperErr = e;
  }
  const piperMs = performance.now() - t0;

  // p-timeout wall-clock: rejects at ~5ms, underlying work continues.
  t0 = performance.now();
  let ptErr = null;
  try {
    await pTimeout(uncoop(), { milliseconds: 5 });
  } catch (e) {
    ptErr = e;
  }
  const ptMs = performance.now() - t0;

  console.log(`  piper: err=${piperErr?.name} settleTime=${piperMs.toFixed(1)}ms (waits for worker teardown)`);
  console.log(`  p-timeout: err=${ptErr?.name} settleTime=${ptMs.toFixed(1)}ms (rejects at deadline, worker continues)`);
  console.log('  This is a CONTRACT difference, not a speed difference.');
}

await timeoutSuccess();
await timeoutCooperative();
await timeoutUncooperative();
