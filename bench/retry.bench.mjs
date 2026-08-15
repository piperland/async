// PIPER ASYNC — retry benchmark.
// Semantic equivalence: Piper `attempts: N` == p-retry `retries: N-1` (both
// mean N total executions). Configured with no delay for a control benchmark.
// p-retry 8.x default backoff (exponential) is DISABLED via minTimeout:0,
// factor:1, randomize:false for the no-delay control. A separate behavioral
// note records that p-retry special-cases AbortError/TypeError in ways Piper
// does not.

import { retry } from '../dist/index.js';
import pRetry from 'p-retry';
import { createBench, runBench } from './helpers/harness.mjs';

const NO_DELAY = { minTimeout: 0, factor: 1, randomize: false };

async function retrySuccessFirst() {
  const bench = createBench();
  bench.add('piper retry success-first', async () => {
    await retry(async () => 'ok', { attempts: 1 });
  });
  bench.add('p-retry success-first', async () => {
    await pRetry(async () => 'ok', { retries: 0 });
  });
  bench.add('direct call floor', async () => {
    await (async () => 'ok')();
  });
  await runBench(bench, 'retry A success first attempt');
}

async function retryFailThenSuccess() {
  const bench = createBench();
  for (const total of [3, 10]) {
    bench.add(`piper retry ${total} attempts`, async () => {
      let calls = 0;
      await retry(async () => {
        calls++;
        if (calls < total) throw new Error('fail');
        return 'ok';
      }, { attempts: total });
    });
    bench.add(`p-retry ${total - 1} retries`, async () => {
      let calls = 0;
      await pRetry(async () => {
        calls++;
        if (calls < total) throw new Error('fail');
        return 'ok';
      }, { retries: total - 1, ...NO_DELAY });
    });
  }
  await runBench(bench, 'retry B fail K-1 then success');
}

async function retryExhaust() {
  const bench = createBench();
  const attempts = 10;
  const err = new Error('always-fail');
  bench.add(`piper retry exhaust ${attempts}`, async () => {
    try {
      await retry(async () => {
        throw err;
      }, { attempts });
    } catch {
      // expected
    }
  });
  bench.add(`p-retry exhaust ${attempts - 1}`, async () => {
    try {
      await pRetry(async () => {
        throw err;
      }, { retries: attempts - 1, ...NO_DELAY });
    } catch {
      // expected
    }
  });
  await runBench(bench, 'retry C exhaustion');
}

async function retryAbort() {
  // Behavioral: cancellation responsiveness.
  console.log('\n=== retry E parent abort (behavioral) ===');
  for (const impl of ['piper', 'p-retry']) {
    const ctrl = new AbortController();
    const t0 = performance.now();
    let calls = 0;
    let rejected = false;
    const p = (() => {
      if (impl === 'piper') {
        return retry(async () => {
          calls++;
          throw new Error('fail');
        }, { attempts: 100, signal: ctrl.signal });
      }
      return pRetry(async () => {
        calls++;
        throw new Error('fail');
      }, { retries: 100, signal: ctrl.signal, ...NO_DELAY });
    })().catch(() => {
      rejected = true;
    });
    setTimeout(() => ctrl.abort(new Error('stop')), 5);
    await p;
    console.log(`  ${impl}: rejected=${rejected} calls=${calls} settleTime=${(performance.now() - t0).toFixed(1)}ms`);
  }
}

await retrySuccessFirst();
await retryFailThenSuccess();
await retryExhaust();
await retryAbort();
