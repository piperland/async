import { type Awaitable, createOwned } from './internal/owned.js';
import { composeSignal, requestCancellation } from './internal/signal.js';

/**
 * The handle passed to the `scope` callback.
 *
 * `signal` conveys cancellation only — it does not register ownership.
 * `spawn` starts a concurrent owned child whose lifetime is bound to the scope.
 */
export interface Scope {
  /** The scope's effective AbortSignal (external composed via AbortSignal.any). */
  readonly signal: AbortSignal;

  /**
   * Start a concurrent owned child. Returns the child's Promise.
   * The child can never outlive the scope.
   *
   * Throws synchronously if the scope is no longer accepting work.
   */
  spawn<T>(worker: (signal: AbortSignal) => Awaitable<T>): Promise<T>;
}

interface ScopeOptions {
  /** External AbortSignal to compose with the scope's own cancellation. */
  signal?: AbortSignal;
}

type ScopePhase = 'open' | 'closing' | 'closed';

/**
 * Structured concurrency boundary.
 *
 * The callback is the implicit root task: plain awaited work inside it is owned
 * (the callback is awaited). `scope.spawn()` starts concurrent children.
 *
 * Normal completion: close to new children, await owned children naturally,
 * return the callback result.
 *
 * Authoritative failure (child failure, callback failure, or external
 * cancellation — whichever is FIRST): close, request cancellation, await root
 * callback + children teardown, reject with the authoritative cause.
 */
export function scope<T>(
  callback: (scope: Scope) => Awaitable<T>,
  options: ScopeOptions = {},
): Promise<T> {
  if (typeof callback !== 'function') {
    throw new TypeError('scope(callback) requires a function callback');
  }

  const { controller, signal } = composeSignal(options.signal);
  let phase: ScopePhase = 'open';

  const owned = createOwned(signal, () => {
    // First authoritative child failure: cancel siblings (fail-fast).
    requestCancellation(controller, signal, owned.failure);
  });

  // External/parent cancellation is authoritative if it is the first terminal
  // cause (error precedence law).
  signal.addEventListener(
    'abort',
    () => {
      owned.recordCancellation(signal.reason);
    },
    { once: true },
  );

  // The scope stops accepting work when it is closing OR when its effective
  // signal has aborted (cancellation/closing in progress).
  function isAcceptingWork(): boolean {
    return phase === 'open' && !signal.aborted;
  }

  const s: Scope = {
    signal,
    spawn<T>(worker: (signal: AbortSignal) => Awaitable<T>): Promise<T> {
      if (!isAcceptingWork()) {
        throw new TypeError(
          'scope.spawn() called after the scope stopped accepting work',
        );
      }
      let promise: Promise<T>;
      try {
        promise = Promise.resolve(worker(signal)) as Promise<T>;
      } catch (error) {
        promise = Promise.reject(error) as Promise<T>;
      }
      owned.track(promise);
      return promise;
    },
  };

  async function run(): Promise<T> {
    // If the effective signal is already aborted at start, reject immediately
    // without running the callback.
    if (signal.aborted) {
      phase = 'closed';
      owned.recordCancellation(signal.reason);
      throw signal.reason;
    }

    let result: T;
    try {
      result = await callback(s);
    } catch (error) {
      phase = 'closing';
      // callback failure is authoritative if it is the first terminal cause
      if (owned.failure === undefined && !signal.aborted) {
        requestCancellation(controller, signal, error);
      }
      await owned.settle();
      phase = 'closed';
      throw authoritativeError(error);
    }

    // Normal callback completion.
    phase = 'closing';
    await owned.settle();
    phase = 'closed';
    if (owned.failure !== undefined) {
      throw owned.failure;
    }
    return result;
  }

  function authoritativeError(callbackError: unknown): unknown {
    // Error precedence: FIRST terminal cause wins.
    //   child failure > callback failure > external cancellation
    if (owned.failure !== undefined) {
      return owned.failure;
    }
    if (signal.aborted) {
      return signal.reason;
    }
    return callbackError;
  }

  return run();
}
