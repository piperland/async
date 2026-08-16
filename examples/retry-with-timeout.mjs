// Flaky external operation: retry with a per-attempt timeout, wired to a parent
// AbortSignal. This is the canonical composition for "try up to N times, each
// attempt bounded by a deadline, and stop immediately if the parent aborts".
//
// Run:  node examples/retry-with-timeout.mjs

import { retry, timeout } from '@piperland/async';

let call = 0;

// A flaky operation: fails transiently, succeeds on the third attempt.
function flakyWork(signal) {
  const attempt = ++call;
  return new Promise((resolve, reject) => {
    if (attempt >= 3) return resolve('stable value');
    const timer = setTimeout(
      () => reject(new Error(`attempt ${attempt} transient failure`)),
      20,
    );
    signal?.addEventListener('abort', () => {
      clearTimeout(timer);
      reject(signal.reason);
    }, { once: true });
  });
}

const value = await retry(
  (signal) => timeout((attemptSignal) => flakyWork(attemptSignal), 100, { signal }),
  { attempts: 4 },
);

console.log('retry + per-attempt timeout →', value, '| attempts:', call);

// --- Parent cancellation: abort the whole retry chain mid-flight. ---
call = 0;
const controller = new AbortController();
const outcome = retry(
  (signal) => timeout((attemptSignal) => flakyWork(attemptSignal), 100, { signal }),
  { attempts: 10, signal: controller.signal },
).then(
  (v) => ({ ok: true, v }),
  (error) => ({ ok: false, reason: error.message }),
);
setTimeout(() => controller.abort(new Error('parent shutdown')), 60);
const result = await outcome;

console.log('after parent abort →', JSON.stringify(result), '| attempts:', call);
