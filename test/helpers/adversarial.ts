// Deterministic adversarial test helpers for Piper.
// Test-only machinery. NOT imported by production source.

/** A manually-resolvable Promise. */
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

/** A gate: resolves all waiters when opened. */
export function gate(): {
  open: () => void;
  wait: () => Promise<void>;
  readonly opened: boolean;
} {
  let openResolve: () => void;
  let opened = false;
  const waiters: Array<() => void> = [];
  const promise = new Promise<void>((resolve) => {
    openResolve = resolve;
  });
  return {
    open() {
      if (opened) return;
      opened = true;
      openResolve();
      // flush queued waiters
      for (const w of waiters) w();
      waiters.length = 0;
    },
    async wait() {
      if (opened) return;
      await promise;
    },
    get opened() {
      return opened;
    },
  };
}

/** A barrier: N parties, all must arrive before any proceeds. */
export function barrier(n: number): {
  arrive: () => Promise<void>;
  readonly parties: number;
} {
  let arrived = 0;
  const d = deferred<void>();
  return {
    async arrive() {
      arrived++;
      if (arrived === n) {
        d.resolve();
      }
      await d.promise;
    },
    get parties() {
      return n;
    },
  };
}

/** A simple deterministic event recorder. */
export function recorder(): {
  push: (e: string) => void;
  get events(): string[];
  count: (e: string) => number;
  includes: (e: string) => boolean;
} {
  const events: string[] = [];
  return {
    push(e) {
      events.push(e);
    },
    get events() {
      return events;
    },
    count(e) {
      return events.filter((x) => x === e).length;
    },
    includes(e) {
      return events.includes(e);
    },
  };
}

// ---- Seeded PRNG (mulberry32) for reproducible random schedules ----
export function mulberry32(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a |= 0;
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

export type Rng = () => number;

/** Pick a random element from an array. */
export function pick<T>(rng: Rng, arr: T[]): T {
  return arr[Math.floor(rng() * arr.length)] ?? arr[0];
}

/** A random int in [min, max]. */
export function randInt(rng: Rng, min: number, max: number): number {
  return min + Math.floor(rng() * (max - min + 1));
}

// ---- Controlled sync iterator ----
export function controlledIterable<T>(
  items: T[],
  opts: { throwOnNext?: () => never } = {},
): { iterable: Iterable<T>; nexts: number } {
  let nexts = 0;
  const iterable: Iterable<T> = {
    [Symbol.iterator]() {
      let i = 0;
      return {
        next(): IteratorResult<T> {
          if (opts.throwOnNext) opts.throwOnNext();
          if (i >= items.length) return { done: true, value: undefined };
          nexts++;
          return { done: false, value: items[i++] };
        },
      };
    },
  };
  return { iterable, nexts };
}

// ---- Controlled async iterator ----
export type AsyncIteratorOpts = {
  /** Called before each next() (can throw). */
  onNext?: () => void;
  /** Whether return() should throw. */
  returnThrows?: boolean;
  /** Whether return() is absent. */
  noReturn?: boolean;
  /** Track return() invocations. */
  returns?: { count: number };
  /** Delay each next() by this many ms. */
  nextDelayMs?: number;
};

export function controlledAsyncIterable<T>(
  items: T[],
  opts: AsyncIteratorOpts = {},
): { iterable: AsyncIterable<T>; nexts: number; returns: { count: number } } {
  let nexts = 0;
  const returns = opts.returns ?? { count: 0 };
  const iterable: AsyncIterable<T> = {
    [Symbol.asyncIterator]() {
      let i = 0;
      return {
        async next(): Promise<IteratorResult<T>> {
          if (opts.onNext) opts.onNext();
          if (opts.nextDelayMs) {
            await new Promise((r) => setTimeout(r, opts.nextDelayMs));
          }
          if (i >= items.length) return { done: true, value: undefined };
          nexts++;
          return { done: false, value: items[i++] };
        },
        async return(): Promise<IteratorResult<T>> {
          returns.count++;
          if (opts.noReturn) {
            // a malformed iterator: return absent at runtime
          }
          if (opts.returnThrows) {
            throw new Error('return-throws');
          }
          return { done: true, value: undefined };
        },
      };
    },
  };
  return { iterable, nexts, returns };
}

// ---- Unhandled rejection instrumentation ----
export function trackUnhandledRejections(): {
  observed: unknown[];
  stop: () => void;
} {
  const observed: unknown[] = [];
  const handler = (reason: unknown) => {
    observed.push(reason);
  };
  process.on('unhandledRejection', handler);
  return {
    observed,
    stop() {
      process.off('unhandledRejection', handler);
    },
  };
}

// ---- A worker that observes a signal and records abort ----
export function signalAwareWorker(
  name: string,
  rec: { push: (e: string) => void },
  opts: {
    ignoreAbort?: boolean;
    resolveOnAbort?: boolean;
    finishDelayMs?: number;
  } = {},
) {
  return async (signal: AbortSignal): Promise<string> => {
    rec.push(`${name}:start`);
    if (signal.aborted) {
      rec.push(`${name}:aborted-at-start`);
      throw signal.reason;
    }
    const d = deferred<string>();
    const onAbort = () => {
      rec.push(`${name}:aborted`);
      if (opts.ignoreAbort) {
        // ignore: keep running (finish later via finishDelayMs)
        if (opts.finishDelayMs) {
          setTimeout(() => {
            rec.push(`${name}:done`);
            d.resolve(name);
          }, opts.finishDelayMs);
        }
      } else if (opts.resolveOnAbort) {
        rec.push(`${name}:resolved-on-abort`);
        d.resolve(name);
      } else {
        d.reject(signal.reason);
      }
    };
    signal.addEventListener('abort', onAbort, { once: true });
    // default finish path if never aborted
    if (!opts.ignoreAbort && opts.finishDelayMs) {
      setTimeout(() => {
        signal.removeEventListener('abort', onAbort);
        rec.push(`${name}:done`);
        d.resolve(name);
      }, opts.finishDelayMs);
    }
    return d.promise;
  };
}

/** Flush microtasks + a macrotask tick. */
export function tick(): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, 0));
}
