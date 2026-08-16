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

## The six primitives

```js
import { scope, any, retry, timeout, race, map } from '@piperland/async';
```

> **Cancellation is cooperative.** Piper gives each worker an `AbortSignal`. To actually
> stop work, pass that signal into the async operation that should stop — e.g.
> `fetch(url, { signal })`. Piper requests cancellation and awaits teardown; it cannot
> forcibly terminate arbitrary JavaScript that ignores its signal.

### `scope(callback, { signal })`

A structured-concurrency boundary. The callback is the root task; `scope.spawn()` starts
owned children that can never outlive the scope.

```js
await scope(async (s) => {
  const a = s.spawn((signal) => fetch('/a', { signal }));
  const b = s.spawn((signal) => fetch('/b', { signal }));
  return combine(await a, await b); // scope waits for both
});
```

- Sequential `await` work inside the callback needs no `spawn` — it is already owned by the
  callback.
- The first child failure fails the scope and cancels siblings (fail-fast).
- An external `{ signal }` cancels the whole scope; `s.signal` carries cancellation.
- `s.spawn(...)` after the scope stops accepting work throws synchronously.

### `retry(worker, { attempts, delay, signal })`

Re-runs a worker until it succeeds or `attempts` (default 3, **including the first**) is
exhausted. `attempts: 3` means at most 3 total attempts (2 retries).

```js
await retry(() => fetch('/flaky'), { attempts: 3 });
await retry((signal) => fetch('/flaky', { signal }), { attempts: 3, delay: 100 });
```

- Parent cancellation stops retrying (no new attempt after an abort).
- An ordinary rejection is retryable; a parent abort is not.
- Compose per-attempt timeouts with `timeout()`:
  `retry((signal) => timeout((s) => fetch(url, { signal: s }), 500, { signal }), { attempts: 3 })`.

### `timeout(worker, milliseconds, { signal })`

**Strong timeout** — `timeout()`, `race()`, and `any()` all use strong teardown: they
request cancellation, then **await owned work to settle before returning**. An uncooperative
worker (one that ignores its signal) can therefore delay settlement. This is the price of
not leaving work behind.

```js
await timeout((signal) => fetch('/slow', { signal }), 1000);
```

### `race(workers, { signal })`

**Strong race — first SETTLED.** The first settled competitor determines the result; losers
are cancelled and **awaited to teardown before `race()` settles**. This differs from
`Promise.race()`, which returns immediately and lets losers keep running.

```js
await race([() => providerA(), () => providerB()]);
```

### `any(workers, { signal })`

**Strong first-SUCCESS.** The first *successful* competitor determines the result; a
rejection does **not** end `any()` while another candidate may still succeed. Losers are
cancelled and awaited to teardown before `any()` settles. If every worker rejects, `any()`
rejects with an `AggregateError` (reasons in input order), like `Promise.any([])`.

```js
// try the primary; if it fails, use the first replica that succeeds
await any([
  (signal) => fetch(primary, { signal }),
  (signal) => fetch(replicaA, { signal }),
  (signal) => fetch(replicaB, { signal }),
]);
```

> **race() vs any():** `race()` = first **settled** (first outcome, success *or* failure).
> `any()` = first **successful** (keeps trying past failures). Both cancel remaining workers
> and await teardown after a winner is selected.

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

## Examples

Run these against the installed package (`node examples/<name>.mjs`). Each is
self-contained and shows a realistic composition.

- `http-fanout.mjs` — bounded-concurrency fan-out of HTTP requests with per-request
  timeout, ordered results, and fail-fast cancellation (`map` + `timeout`).
- `structured-request.mjs` — one request assembled from parallel dependencies with
  sibling cancellation and cleanup on failure (`scope`).
- `retry-with-timeout.mjs` — flaky operation retried with a per-attempt timeout and
  parent-signal cancellation (`retry` + `timeout`).
- `async-iterable.mjs` — bounded-concurrency processing of an async iterable with lazy
  pulling and ordered results (`map`).
- `provider-failover.mjs` — primary fails quickly, a replica succeeds, the slow loser is
  cancelled — first success wins (`any`).

A canonical composition that appears throughout:

```js
// up to N attempts, each bounded by a per-attempt deadline, all cancellable
const value = await retry(
  (signal) => timeout((attemptSignal) => doWork(attemptSignal), 500, { signal }),
  { attempts: 3, signal: parentSignal },
);
```

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
