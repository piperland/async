import type { Awaitable } from './internal/owned.js';
import { composeSignal } from './internal/signal.js';

interface MapOptions {
  /** Maximum number of concurrently running workers. REQUIRED. */
  concurrency: number;
  /** External/parent AbortSignal. Parent abort stops the map. */
  signal?: AbortSignal;
}

/**
 * Bounded concurrent map.
 *
 * - `concurrency` is required: a positive integer >= 1. `Infinity` means
 *   explicitly unbounded concurrency.
 * - Preserves input order in results (completion order may differ).
 * - Lazy input pulling over Iterable or AsyncIterable.
 * - Fail-fast: the first worker failure is authoritative. On failure or
 *   cancellation, stops pulling, requests cancellation of started workers,
 *   awaits their teardown, then settles with the authoritative result.
 * - For AsyncIterable, `iterator.return()` is invoked on early stop so
 *   generators are not left open.
 */
export function map<T, R>(
  iterable: Iterable<T> | AsyncIterable<T>,
  mapper: (item: T, index: number, signal: AbortSignal) => Awaitable<R>,
  options: MapOptions,
): Promise<R[]> {
  if (iterable == null) {
    throw new TypeError('map(iterable, mapper) requires an iterable');
  }
  if (typeof mapper !== 'function') {
    throw new TypeError('map(iterable, mapper) requires a mapper function');
  }
  const { concurrency } = options;
  if (
    concurrency !== Infinity &&
    (!Number.isInteger(concurrency) || concurrency < 1)
  ) {
    throw new RangeError(
      `map concurrency must be a positive integer (>= 1) or Infinity, got ${String(concurrency)}`,
    );
  }

  const { controller, signal } = composeSignal(options.signal);
  // Whether the signal was aborted by OUR internal fail-fast (not a parent
  // abort). We distinguish so the authoritative result is the worker failure,
  // not the internal abort reason.
  let internalAbort = false;

  const results: R[] = [];
  let index = 0;

  // Normalize to an async iterator (sync iterables are wrapped).
  const asyncIterator =
    typeof (iterable as AsyncIterable<T>)[Symbol.asyncIterator] === 'function'
      ? (iterable as AsyncIterable<T>)[Symbol.asyncIterator]()
      : (iterable as Iterable<T>)[Symbol.iterator]();

  // Track whether we must call iterator.return() on early stop.
  let iteratorClosed = false;
  async function closeIterator(): Promise<void> {
    if (iteratorClosed) return;
    iteratorClosed = true;
    const ret = (asyncIterator as AsyncIterator<T>).return;
    if (typeof ret === 'function') {
      try {
        await ret.call(asyncIterator);
      } catch {
        // closing the iterator is best-effort
      }
    }
  }

  return (async () => {
    let pullError: unknown;
    let finished = false;

    // A worker runner: pulls ONE item, awaits its mapper job, then pulls the
    // next. Exactly `concurrency` runners => at most `concurrency` concurrent
    // jobs. This is what bounds concurrency.
    async function runner(): Promise<void> {
      while (!finished) {
        if (signal.aborted) {
          await closeIterator();
          finished = true;
          return;
        }
        let next: IteratorResult<T>;
        try {
          next = await asyncIterator.next();
        } catch (error) {
          await closeIterator();
          finished = true;
          if (pullError === undefined) pullError = error;
          return;
        }
        if (next.done) {
          finished = true;
          return;
        }
        const i = index++;
        const item = next.value;
        try {
          const value = await mapper(item, i, signal);
          results[i] = value;
        } catch (error) {
          // First authoritative worker failure (fail-fast): cancel siblings.
          if (pullError === undefined && !signal.aborted) {
            pullError = error;
            internalAbort = true;
            controller.abort(error);
          }
        }
      }
    }

    // For Infinity concurrency, each item gets its own job in flight. Use a
    // single runner that dispatches without awaiting (unbounded).
    const runners: Promise<void>[] = [];
    if (concurrency === Infinity) {
      const inflight = new Set<Promise<void>>();
      async function unboundedRunner(): Promise<void> {
        while (!finished) {
          if (signal.aborted) {
            await closeIterator();
            finished = true;
            return;
          }
          let next: IteratorResult<T>;
          try {
            next = await asyncIterator.next();
          } catch (error) {
            await closeIterator();
            finished = true;
            if (pullError === undefined) pullError = error;
            return;
          }
          if (next.done) {
            finished = true;
            break;
          }
          const i = index++;
          const item = next.value;
          const job = (async () => {
            try {
              results[i] = await mapper(item, i, signal);
            } catch (error) {
              if (pullError === undefined && !signal.aborted) {
                pullError = error;
                internalAbort = true;
                controller.abort(error);
              }
            }
          })();
          inflight.add(job);
          void job.finally(() => inflight.delete(job)).catch(() => {});
        }
        while (inflight.size > 0) {
          await Promise.allSettled([...inflight]);
        }
      }
      runners.push(unboundedRunner());
    } else {
      for (let r = 0; r < concurrency; r++) {
        runners.push(runner());
      }
    }

    await Promise.allSettled(runners);
    await new Promise<void>((resolve) => {
      // Give any in-flight unbounded jobs a tick to finish their cleanup.
      queueMicrotask(() => resolve());
    });

    // Determine the authoritative result.
    if (pullError !== undefined) {
      throw pullError;
    }
    if (signal.aborted && !internalAbort) {
      // A parent abort (not our internal fail-fast) is authoritative.
      throw signal.reason;
    }
    // Ensure no holes (map always fills results in order by construction).
    return results;
  })();
}
