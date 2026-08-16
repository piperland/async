import { type Awaitable, createOwned } from './internal/owned.js';

interface AnyOptions {
  /** External/parent AbortSignal. Parent abort wins if it aborts first. */
  signal?: AbortSignal;
}

/**
 * Strong first-success.
 *
 * The FIRST SUCCESSFUL competitor determines the selected result. Rejections are
 * observed and retained (for the all-fail `AggregateError`); a rejection does
 * NOT end `any()` while another candidate may still succeed. Unfinished
 * competitors receive cancellation once a success is selected, and `any()`
 * awaits ALL competitor teardown before settling with the winning value.
 *
 * This is the strong first-success sibling of `race()` (first-settled). It
 * deliberately differs from `Promise.any()` only in teardown timing, not
 * selection semantics. An uncooperative loser may delay settlement — that is
 * intentional structured ownership. There is NO weak mode.
 *
 * All workers failing rejects with `AggregateError` (`.errors` in INPUT ORDER),
 * like `Promise.any([])` — no custom error class.
 *
 * Overload 1 (tuple): heterogeneous workers infer the UNION of their result
 * types (e.g. `any([() => 'a', () => 1])` → `Promise<string | number>`),
 * matching `race`'s inference for heterogeneous inputs.
 */
export function any<const T extends readonly unknown[]>(
  workers: { [K in keyof T]: (signal: AbortSignal) => Awaitable<T[K]> },
  options?: AnyOptions,
): Promise<T[number]>;

/**
 * Overload 2 (iterable): homogeneous workers via a single result type.
 */
export function any<T>(
  workers: Iterable<(signal: AbortSignal) => Awaitable<T>>,
  options?: AnyOptions,
): Promise<T>;

export function any<T>(
  workers: Iterable<(signal: AbortSignal) => Awaitable<T>>,
  options: AnyOptions = {},
): Promise<T> {
  if (workers == null || typeof workers[Symbol.iterator] !== 'function') {
    throw new TypeError('any(workers) requires an iterable of workers');
  }

  const parent = options.signal;
  // An any-internal controller used ONLY to cancel still-pending losers once a
  // success is selected (or selection is abandoned).
  const selectionController = new AbortController();
  // Candidates receive the parent composed with the any-internal controller.
  const candidateSignal = parent
    ? AbortSignal.any([parent, selectionController.signal])
    : selectionController.signal;

  const owned = createOwned(candidateSignal, () => {
    // Loser failures are secondary (observed, never unhandled). A candidate
    // rejection is not itself terminal — any() keeps waiting for a success.
  });

  // Materialize the iterable once (workers would start in the same JS turn).
  let workerFns: Array<(signal: AbortSignal) => Awaitable<T>>;
  try {
    workerFns = [...workers];
  } catch (error) {
    return Promise.reject(error);
  }

  // An already-aborted parent must reject WITHOUT starting any worker.
  if (parent?.aborted) {
    return Promise.reject(parent.reason);
  }

  // No candidates -> nothing can succeed. Follow Promise.any([]): AggregateError.
  if (workerFns.length === 0) {
    return Promise.reject(new AggregateError([], ALL_FAILED_MESSAGE));
  }

  // Validate every worker BEFORE starting any. A malformed entry (eager Promise,
  // null, number, object, ...) is programmer error — it must become an
  // authoritative TypeError that a legitimate success can NEVER mask. Because
  // the iterable was materialized eagerly, validation happens before any worker
  // function runs, so no owned work starts on invalid input.
  for (let i = 0; i < workerFns.length; i++) {
    const entry: unknown = workerFns[i];
    if (typeof entry !== 'function') {
      // If it is an already-started (eager) rejected Promise, observe its
      // rejection so it does not surface as an unhandled rejection.
      if (
        entry != null &&
        typeof (entry as PromiseLike<unknown>).then === 'function'
      ) {
        Promise.resolve(entry as PromiseLike<unknown>).catch(() => {});
      }
      return Promise.reject(new TypeError(INVALID_WORKER_MESSAGE));
    }
  }

  const workerCount = workerFns.length;
  // Fixed-size, filled by INPUT index so the all-fail AggregateError preserves
  // reasons in INPUT ORDER — exactly aligned with native Promise.any (ECMAScript
  // assigns each candidate an input index and writes its reason into
  // errors[index], regardless of rejection timing).
  const errors: unknown[] = new Array(workerCount);
  let rejectedCount = 0;

  const candidatePromises = workerFns.map((fn) => {
    let promise: Promise<T>;
    try {
      promise = Promise.resolve(fn(candidateSignal)) as Promise<T>;
    } catch (error) {
      promise = Promise.reject(error) as Promise<T>;
    }
    owned.track(promise);
    return promise;
  });

  return new Promise<T>((resolve, reject) => {
    let selected = false;

    // Parent abort is authoritative only if it happens before a success wins.
    function selectParentAbort(): void {
      if (selected || !parent?.aborted) return;
      selected = true;
      // Candidates already observe the parent abort via AbortSignal.any; no
      // need to abort selectionController. Await teardown, then reject with the
      // authoritative parent reason.
      void owned.settle().then(() => {
        reject(parent.reason);
      });
    }

    if (parent) {
      if (parent.aborted) {
        selectParentAbort();
      } else {
        parent.addEventListener(
          'abort',
          () => {
            selectParentAbort();
          },
          { once: true },
        );
      }
    }

    function selectSuccess(value: T): void {
      if (selected) return;
      selected = true;
      // Request cancellation of every still-pending loser.
      if (!selectionController.signal.aborted) {
        selectionController.abort(LOST_SELECTION_REASON);
      }
      void owned.settle().then(() => {
        resolve(value);
      });
    }

    function selectAllFailed(): void {
      if (selected) return;
      selected = true;
      // All candidates already rejected; nothing left to cancel.
      void owned.settle().then(() => {
        reject(new AggregateError(errors, ALL_FAILED_MESSAGE));
      });
    }

    candidatePromises.forEach((promise, index) => {
      promise.then(
        (value) => selectSuccess(value),
        (error) => {
          if (selected) return; // post-selection rejection: a secondary teardown casualty
          errors[index] = error;
          rejectedCount++;
          if (rejectedCount === workerCount) {
            selectAllFailed();
          }
        },
      );
    });
  });
}

// Shared reason for loser cancellation once a success is selected. Frozen so no
// consumer can mutate it across any() calls (a DOMException is extensible by
// default; a mutable shared instance would leak into unrelated calls — the same
// cross-call mutation bug Run 010A found with race's shared reason). Identity is
// not part of the contract (losers observe name/message/type via
// throwIfAborted / signal.reason), so a shared immutable sentinel is safe.
const LOST_SELECTION_REASON = Object.freeze(
  new DOMException('Lost selection', 'AbortError'),
);

// Matches native Promise.any's message; the portable contract is the type and
// `.errors`, not this host text.
const ALL_FAILED_MESSAGE = 'All promises were rejected';

// Clear message for a malformed worker entry. Piper takes lazy functions, not
// already-started Promises or other values.
const INVALID_WORKER_MESSAGE =
  'Expected worker to be a function (got a non-function; eager Promises are not workers)';
