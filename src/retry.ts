import type { Awaitable } from './internal/owned.js';
import { composeSignal } from './internal/signal.js';
import {
  assertFiniteNonNegative,
  assertPositiveInteger,
} from './internal/validate.js';

interface RetryOptions {
  /** Number of attempts INCLUDING the first execution. Default 3. */
  attempts?: number;
  /** Fixed milliseconds between failed attempts. Default 0. */
  delay?: number;
  /** External/parent AbortSignal. Parent abort stops retrying. */
  signal?: AbortSignal;
}

const DEFAULT_ATTEMPTS = 3;

/**
 * Retry a worker until it succeeds or attempts are exhausted.
 *
 * - `attempts` includes the first execution (`attempts: 1` = no retry).
 * - Parent cancellation is NOT retryable: an abort stops the loop, aborts the
 *   current attempt, awaits its teardown, and rejects with the parent reason.
 * - An ordinary worker rejection IS retryable. A per-attempt timeout
 *   (TimeoutError from the attempt's OWN signal) is a retryable ordinary
 *   failure — classification is by parent signal state, not error name.
 */
export function retry<T>(
  worker: (signal: AbortSignal) => Awaitable<T>,
  options: RetryOptions = {},
): Promise<T> {
  if (typeof worker !== 'function') {
    throw new TypeError('retry(worker) requires a function worker');
  }
  const attempts = options.attempts ?? DEFAULT_ATTEMPTS;
  const delay = options.delay ?? 0;
  assertPositiveInteger(attempts, 'attempts');
  assertFiniteNonNegative(delay, 'delay');

  const { signal } = composeSignal(options.signal);

  return (async () => {
    for (let attempt = 1; attempt <= attempts; attempt++) {
      if (signal.aborted) {
        throw signal.reason;
      }
      const attemptController = new AbortController();
      // Only compose via AbortSignal.any when there is a parent signal.
      // AbortSignal.any([singleSignal]) retains the source signal's listener
      // (native behavior) and would leak on hot retry paths.
      const attemptSignal = options.signal
        ? AbortSignal.any([signal, attemptController.signal])
        : attemptController.signal;

      try {
        return await worker(attemptSignal);
      } catch (error) {
        // Parent aborted → cancellation, NOT retryable.
        if (signal.aborted) {
          throw signal.reason;
        }
        // Ordinary failure (including a per-attempt TimeoutError from the
        // attempt's OWN signal) is retryable if attempts remain.
        if (attempt < attempts) {
          if (delay > 0) {
            await sleep(delay, signal);
            if (signal.aborted) {
              throw signal.reason;
            }
          }
          continue;
        }
        throw error;
      }
    }
    // Unreachable: attempts >= 1 guarantees a return or throw.
    throw new Error('retry exhausted attempts');
  })();
}

function sleep(ms: number, signal: AbortSignal): Promise<void> {
  return new Promise<void>((resolve, reject) => {
    const timer = setTimeout(() => {
      signal.removeEventListener('abort', onAbort);
      resolve();
    }, ms);
    const onAbort = (): void => {
      clearTimeout(timer);
      reject(signal.reason);
    };
    signal.addEventListener('abort', onAbort, { once: true });
  });
}
