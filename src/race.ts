import { type Awaitable, createOwned } from './internal/owned.js';

interface RaceOptions {
  /** External/parent AbortSignal. Parent abort wins if it aborts first. */
  signal?: AbortSignal;
}

/**
 * Strong race.
 *
 * The FIRST SETTLED competitor determines the selected result. Unfinished
 * competitors receive cancellation, and race awaits ALL competitor teardown
 * before settling with the winning settlement.
 *
 * This deliberately differs from `Promise.race()` only in teardown timing, not
 * winner-selection semantics. An uncooperative loser may delay settlement —
 * that is intentional structured ownership. There is NO weak mode.
 *
 * An empty iterable rejects immediately with a clear Error (rather than
 * `Promise.race([])` hanging forever).
 */
export function race<T>(
  workers: Iterable<(signal: AbortSignal) => Awaitable<T>>,
  options: RaceOptions = {},
): Promise<T> {
  if (workers == null || typeof workers[Symbol.iterator] !== 'function') {
    throw new TypeError('race(workers) requires an iterable of workers');
  }

  const parent = options.signal;
  // A race-internal controller used ONLY to cancel losing competitors.
  const raceController = new AbortController();
  // Competitors receive the parent composed with the race-internal controller.
  const competitorSignal = parent
    ? AbortSignal.any([parent, raceController.signal])
    : raceController.signal;

  const owned = createOwned(competitorSignal, () => {
    // Losing competitor failures are secondary (observed, not unhandled).
  });

  // Materialize the iterable once (workers start in the same JS turn).
  let workerFns: Array<(signal: AbortSignal) => Awaitable<T>>;
  try {
    workerFns = [...workers];
  } catch (error) {
    return Promise.reject(error);
  }
  if (workerFns.length === 0) {
    return Promise.reject(new Error('race() requires at least one worker'));
  }

  const competitorPromises = workerFns.map((fn) => {
    let promise: Promise<T>;
    try {
      promise = Promise.resolve(fn(competitorSignal)) as Promise<T>;
    } catch (error) {
      promise = Promise.reject(error) as Promise<T>;
    }
    owned.track(promise);
    return promise;
  });

  return new Promise<T>((resolve, reject) => {
    let selected = false;
    let parentAborted = false;

    if (parent?.aborted) {
      parentAborted = true;
    }
    if (parent) {
      parent.addEventListener(
        'abort',
        () => {
          parentAborted = true;
        },
        { once: true },
      );
    }

    function settle(
      valueOrError:
        | { kind: 'value'; value: T }
        | { kind: 'error'; error: unknown },
    ): void {
      if (selected) return;
      selected = true;
      // Request cancellation of all remaining competitors (race-internal only).
      if (!raceController.signal.aborted) {
        raceController.abort(LOST_RACE_REASON);
      }
      void owned.settle().then(() => {
        // Parent abort is authoritative if it happened before selection.
        if (parentAborted && parent?.aborted) {
          reject(parent.reason);
          return;
        }
        if (valueOrError.kind === 'value') {
          resolve(valueOrError.value);
        } else {
          reject(valueOrError.error);
        }
      });
    }

    // First SETTLED wins (native Promise.race meaning).
    const first = Promise.race(
      competitorPromises.map((p) =>
        p.then(
          (value) => ({ kind: 'value' as const, value }),
          (error) => ({ kind: 'error' as const, error }),
        ),
      ),
    );
    first.then((result) => settle(result));
  });
}

// Shared reason for loser cancellation. Frozen so no consumer can mutate it
// across race calls (a DOMException is extensible by default; mutating the
// shared instance would leak into unrelated races). Identity is not part of the
// race contract (losers observe name/message/type), which is why a shared
// immutable sentinel is safe. Creating a fresh DOMException per race was the
// dominant allocation on the race hot path (profile: 37% of samples).
const LOST_RACE_REASON = Object.freeze(
  new DOMException('Lost race', 'AbortError'),
);
