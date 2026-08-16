// Bounded-concurrency processing of an async iterable (a paginated API, streamed
// records, a log tail) with `map`. Lazy pulling, ordered results, and iterator
// cleanup on failure.
//
// Run:  node examples/async-iterable.mjs

import { map } from '@piperland/async';

// A paginated producer: yields records lazily (one at a time).
async function* paginatedRecords(total) {
  for (let i = 0; i < total; i++) {
    await new Promise((r) => setTimeout(r, 5));
    yield { id: i, payload: `record-${i}` };
  }
}

const processed = await map(
  paginatedRecords(20),
  async (record) => {
    // Simulate per-record processing work.
    await new Promise((r) => setTimeout(r, 8));
    return { id: record.id, done: true };
  },
  { concurrency: 4 }, // at most 4 records in flight; results stay in input order
);

console.log(`processed ${processed.length} records in order:`, processed[0], '…', processed.at(-1));
