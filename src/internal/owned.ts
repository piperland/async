// Shared owned-work settlement for Piper primitives.
//
// Its job is NOT to be a universal async framework. It encodes the shared
// invariant helpers around:
//   - observing owned Promises (including ones the caller ignores)
//   - recording the FIRST authoritative terminal cause (error precedence law)
//   - preventing unhandled secondary failures
//   - waiting for teardown of all owned work
//
// Error-precedence subtlety: a child rejection that happens AFTER the owning
// signal aborted is a teardown casualty — secondary, never primary.

/**
 * A value that can be awaited: either a plain value or a thenable.
 * Internal to the package — not part of the public type surface.
 */
export type Awaitable<T> = T | PromiseLike<T>;

/** Create a manually-resolvable Promise without Promise.withResolvers. */
export function deferred<T = void>(): {
  promise: Promise<T>;
  resolve: (value: T | PromiseLike<T>) => void;
  reject: (reason?: unknown) => void;
} {
  let resolve!: (value: T | PromiseLike<T>) => void;
  let reject!: (reason?: unknown) => void;
  const promise = new Promise<T>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}

export type OwnedTracker = {
  /** Attach an owned promise; observes its rejection without swallowing the caller's own await. */
  track: (promise: Promise<unknown>) => void;
  /** Record cancellation as the terminal cause if nothing prior. */
  recordCancellation: (reason: unknown) => void;
  /** Await all tracked promises to settle. */
  settle: () => Promise<void>;
  /** First authoritative failure, or undefined. */
  readonly failure: unknown;
};

/**
 * Create an owned-work tracker.
 *
 * `signal` is the owning primitive's effective signal: a child rejection after
 * the signal aborted is secondary (teardown casualty), not the primary failure.
 *
 * `onChildFailure` is called exactly once with the FIRST authoritative child
 * failure (used by scope to cancel siblings). Secondary failures are observed
 * but never invoke it again.
 */
export function createOwned(
  signal: AbortSignal,
  onChildFailure: (error: unknown) => void,
): OwnedTracker {
  // Lazy child registry: allocate the Set only on first track(). Most scopes /
  // single-worker primitives never track more than a handful of children, and
  // some track none — the eager Set was a fixed allocation on every entry.
  let pending: Set<Promise<unknown>> | undefined;
  let failure: unknown;

  function track(promise: Promise<unknown>): void {
    if (pending === undefined) pending = new Set();
    pending.add(promise);
    promise.then(
      () => pending?.delete(promise),
      (error) => {
        pending?.delete(promise);
        // A rejection after the signal aborted is a teardown casualty.
        if (failure === undefined && !signal.aborted) {
          failure = error;
          onChildFailure(error);
        }
      },
    );
    // Separate derived promise so a caller ignoring the child's promise does
    // not produce an unhandled rejection. Does NOT swallow the caller's await.
    promise.catch(() => {});
  }

  function recordCancellation(reason: unknown): void {
    if (failure === undefined) {
      failure = reason;
    }
  }

  async function settle(): Promise<void> {
    if (pending === undefined) return;
    while (pending.size > 0) {
      await Promise.allSettled([...pending]);
    }
  }

  return {
    track,
    recordCancellation,
    settle,
    get failure(): unknown {
      return failure;
    },
  };
}
