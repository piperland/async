# Piper Async — Benchmarks

Engineering benchmark harness for the Piper Async v0.1 kernel. These measure
**internal engineering evidence** — correctness-validated performance of the
library and fair comparisons against competitors. No numbers here are product
claims; see the project docs for supported behavior.

## What is measured

Each primitive is benchmarked in scenarios grouped as:

- **MICRO OVERHEAD** — cost of entering a Piper primitive vs a raw floor.
- **SEMANTIC-EQUIVALENT** — same semantic work as a competitor (e.g. finite-array
  bounded map, no-delay retry with equal attempt counts).
- **BEHAVIORAL-COST** — work where the semantics differ (Piper strong timeout/race
  await teardown; competitors may not), reported as timing/contract, not speed.
- **SCALE / MEMORY** — behavior at 1k-100k items, failure storms, allocation.

## Running

Build first (benchmarks import the published output, not `src/`):

```sh
pnpm build
pnpm bench            # run all benchmark groups
pnpm bench:map        # one group
pnpm bench:retry
pnpm bench:timeout
pnpm bench:race
pnpm bench:scope
```

Raw results (JSON) are written to `.agent/benchmarks/results/` (gitignored).
Results are machine-specific — see the header of each output file for the
environment fingerprint. Do not treat numbers from different machines as a
single leaderboard.

## Methodology

- Harness: `tinybench` (dev-only) wrapped by `bench/helpers/harness.mjs`.
- Each scenario: setup (excluded) → timed work → verification (excluded).
  Verification checksum / attempt counts / completion counts must pass or the
  sample is invalid.
- Warmup + multiple samples; report median + dispersion (p75/p99).
- Scenarios import the BUILT package output to measure what a consumer gets.
- Competitor packages are pinned exact dev-dependencies (see `package.json`).

## Semantic fairness

Competitor comparisons state what is held equivalent and what is not:

- `p-limit` / `p-map`: bounded map over a FINITE array is apples-ish; Piper map
  is lazy (bounded pull) where p-limit+Promise.all eagerly materializes jobs.
- `p-retry`: Piper `attempts: N` == p-retry `retries: N-1` (N total executions).
  p-retry's default backoff is disabled (`minTimeout:0, factor:1, randomize:false`)
  for no-delay control benchmarks. p-retry special-cases AbortError/TypeError
  differently from Piper.
- `p-timeout`: takes an eager Promise and cannot cancel underlying work; Piper's
  strong timeout aborts + awaits teardown. Success-before-deadline overhead is a
  direct comparison; timeout-fired scenarios are BEHAVIORAL-COST.
- `Promise.race` is the raw platform floor but LEAKS losing competitors; Piper's
  strong race cancels + awaits teardown. Shown separately with the caveat.
- `scope` has no direct competitor; a hand-written native baseline implements
  the same ownership/fail-fast/teardown semantics.

## Browser

`test/browser/run-browser-test.mjs` executes the built package in headless
Chromium (Playwright) to validate browser semantics.
