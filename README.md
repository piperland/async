# Piper Async

Async control for JavaScript and TypeScript.

Piper Async is a small, composable layer for controlling concurrent asynchronous work
using standard JavaScript primitives. It is not a replacement for `async`/`await` or
`Promise` — it gives you ownership, cancellation, and cleanup over the async work those
primitives start.

> **Beta.** This is a prerelease. The API may evolve before 1.0. The core semantics are
> stable, but names and options can change during beta. Please report friction through
> [Issues](https://github.com/piperland/async/issues) (bug reports or API feedback).

## Install

```sh
npm install @piperland/async@beta
# or: pnpm add @piperland/async@beta · bun add @piperland/async@beta
```

> The package is in beta and publishes under the `beta` npm tag, so the install command
> above pins it. If you install with no tag, npm's `latest` currently points at this beta;
> that will change when a stable release lands.

Zero runtime dependencies.

## Supported runtimes

Validated against the live package in:

| Runtime | Notes |
| --- | --- |
| Node.js | `>= 20.3` |
| Bun | current (1.x) |
| Deno | via `npm:` specifier |
| Browsers | evergreen (Chromium / Firefox / WebKit) |
| Cloudflare Workers | validated in `workerd` |

## The five primitives

```js
import { scope, retry, timeout, race, map } from '@piperland/async';
```

### `scope(callback, { signal })`

A structured-concurrency boundary. The callback is the root task; `scope.spawn()` starts
owned children that can never outlive the scope.

```js
await scope(async (s) => {
  const a = s.spawn(() => fetch('/a'));
  const b = s.spawn(() => fetch('/b'));
  return combine(await a, await b); // scope waits for both
});
```

- Sequential `await` work inside the callback needs no `spawn` — it is already owned by the
  callback.
- The first child failure fails the scope and cancels siblings (fail-fast).
- An external `{ signal }` cancels the whole scope; `s.signal` carries cancellation.
- `s.spawn(...)` after the scope stops accepting work throws synchronously.

### `retry(worker, { attempts, delay, signal })`

Re-runs a worker until it succeeds or `attempts` (default 3, including the first) is
exhausted.

```js
await retry(() => fetch('/flaky'), { attempts: 3 });
await retry((signal) => fetch('/flaky', { signal }), { attempts: 3, delay: 100 });
```

- Parent cancellation stops retrying (no new attempt after an abort).
- An ordinary rejection is retryable; a parent abort is not.
- Compose per-attempt timeouts with `timeout()`:
  `retry((signal) => timeout((s) => fetch(url, { signal: s }), 500, { signal }), { attempts: 3 })`.

### `timeout(worker, milliseconds, { signal })`

**Strong timeout**: on deadline it requests cancellation, awaits the worker's teardown,
then rejects with a `TimeoutError`. This differs from a raw `Promise.race`-style timeout —
if the worker ignores cancellation, `timeout()` waits for it to settle before rejecting.

```js
await timeout((signal) => fetch('/slow', { signal }), 1000);
```

### `race(workers, { signal })`

**Strong race**: the first settled competitor determines the result; losers are cancelled
and **awaited to teardown before `race()` settles**. This differs from `Promise.race()`,
which returns immediately and lets losers keep running.

```js
await race([() => providerA(), () => providerB()]);
```

### `map(iterable, mapper, { concurrency, signal })`

Bounded concurrent mapping over an iterable or async iterable, with ordered results and
lazy input pulling.

```js
await map(ids, (id) => fetchUser(id), { concurrency: 10 });
await map(ids, (id, i, signal) => fetch(`/user/${id}?n=${i}`, { signal }), { concurrency: 10 });
```

- `concurrency` is required (a positive integer, or `Infinity` for unbounded).
- Preserves input order in results (completion order may differ).
- On failure or cancellation, stops pulling and awaits started workers' teardown.

## Ownership and cancellation

Every Piper primitive owns the async work it directly starts until that primitive settles,
and accepts an optional parent `AbortSignal`. This means:

- **No leaked children**: spawned/scoped work cannot outlive its owner.
- **No orphaned rejections**: secondary failures are observed, never unhandled.
- **First error wins**: the first authoritative failure is what surfaces; later failures are
  observed but do not override it.
- **Native reasons**: cancellation uses `AbortSignal` semantics; reasons are preserved
  exactly. There is no proprietary cancellation token or error hierarchy.

## Semantic caveats

- `timeout()` and `race()` intentionally await teardown, so they may settle later than a
  raw wall-clock/Promise.race equivalent if work ignores cancellation. That delay is the
  price of not leaving work behind.
- `map()` is lazy (bounded pull) — it does not eagerly materialize a huge input.
- `retry()` has no per-attempt timeout option; compose one with `timeout()` (see above).

## TypeScript

The public types are `Scope` (the handle passed to `scope` callbacks) and the primitives
themselves. Workers are typed as `(signal: AbortSignal) => Awaitable<T>`; zero-argument
functions are accepted (the signal is passed but may be ignored).

## License

MIT.
