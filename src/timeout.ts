import { type Awaitable, createOwned } from './internal/owned.js';
import { composeSignal, requestCancellation } from './internal/signal.js';
import { assertFiniteNonNegative } from './internal/validate.js';

interface TimeoutOptions {
  /** External/parent AbortSignal. Parent abort reason wins if it aborts first. */
  signal?: AbortSignal;
}

/** The TimeoutError reason used when the timeout's own timer fires. */
export function createTimeoutError(): DOMException {
  return new DOMException('Timeout exceeded', 'TimeoutError');
}

/**
 * Strong timeout.
 *
 * When the deadline is reached: request worker cancellation, await worker
 * teardown, then reject with a TimeoutError.
 *
 * This does NOT guarantee the returned Promise settles by the wall-clock
 * deadline if the worker ignores cancellation — it guarantees owned teardown.
 * It is NOT a Promise.race wrapper.
 *
 * Error precedence: if the parent signal aborts first, the parent reason wins.
 * If the worker fails first, the worker failure wins.
 */
export function timeout<T>(
  worker: (signal: AbortSignal) => Awaitable<T>,
  milliseconds: number,
  options: TimeoutOptions = {},
): Promise<T> {
  if (typeof worker !== 'function') {
    throw new TypeError('timeout(worker, ms) requires a function worker');
  }
  assertFiniteNonNegative(milliseconds, 'milliseconds');

  const { controller, signal } = composeSignal(options.signal);
  // Track the worker promise so teardown is awaited after a timeout fires.
  // A worker rejection after the signal aborted is a teardown casualty.
  const owned = createOwned(signal, () => {});

  let timer: ReturnType<typeof setTimeout> | undefined;

  const workerPromise: Promise<T> = (async () => {
    try {
      return await worker(signal);
    } catch (error) {
      // Observe the rejection through `owned` for teardown tracking, but the
      // authoritative error is decided below by signal state.
      owned.track(Promise.reject(error));
      throw error;
    }
  })();
  owned.track(workerPromise);

  // For ms === 0 the deadline is immediate: abort before the worker can win.
  if (milliseconds === 0) {
    requestCancellation(controller, signal, createTimeoutError());
  }

  return new Promise<T>((resolve, reject) => {
    let settled = false;

    function finishResolve(value: T): void {
      if (settled) return;
      settled = true;
      if (timer !== undefined) clearTimeout(timer);
      resolve(value);
    }

    function finishReject(error: unknown): void {
      if (settled) return;
      settled = true;
      if (timer !== undefined) clearTimeout(timer);
      reject(error);
    }

    workerPromise.then(
      (value) => {
        // Worker succeeded first (and no abort won) → resolve.
        if (!signal.aborted) {
          finishResolve(value);
        }
      },
      (error) => {
        // Authoritative precedence:
        //   signal aborted (timeout fired or parent aborted) → signal.reason
        //   worker failed first → worker error
        if (signal.aborted) {
          finishReject(signal.reason);
        } else {
          finishReject(error);
        }
      },
    );

    // Own timer for strong-teardown semantics (NOT AbortSignal.timeout).
    timer = setTimeout(() => {
      requestCancellation(controller, signal, createTimeoutError());
      // Await owned teardown, THEN reject with the authoritative reason.
      void owned.settle().then(() => {
        finishReject(signal.aborted ? signal.reason : createTimeoutError());
      });
    }, milliseconds);

    if (signal.aborted) {
      // Already aborted at entry: reject immediately with the reason.
      owned.recordCancellation(signal.reason);
      finishReject(signal.reason);
    }
  });
}
