// HTTP fan-out with bounded concurrency, per-request timeout, ordered results,
// and fail-fast cancellation — using `map` + `timeout` + native `fetch`.
//
// Run:  node examples/http-fanout.mjs
// This example is self-contained against a tiny local server.

import { map, timeout } from '@piperland/async';
import { createServer } from 'node:http';

// A deterministic local server (stands in for any external API).
const server = createServer((req, res) => {
  const delay = Number((req.url || '/').slice(1) || 0);
  setTimeout(() => {
    res.writeHead(req.url === '/fail' ? 500 : 200);
    res.end(req.url === '/fail' ? 'boom' : `data-${req.url.slice(1)}`);
  }, delay);
});
await new Promise((r) => server.listen(0, r));
const base = `http://127.0.0.1:${server.address().port}`;

async function fetchJson(url, signal) {
  const res = await fetch(url, { signal });
  if (!res.ok) throw new Error(`HTTP ${res.status} for ${url}`);
  return res.text();
}

// Bounded fan-out: at most 3 requests in flight, each with a 500 ms timeout.
// Results come back in input order; if any request fails, in-flight work is
// cancelled (fail-fast) and the error propagates.
const ids = ['/10', '/20', '/30', '/40', '/50'];
const results = await map(
  ids,
  (id) => timeout((signal) => fetchJson(base + id, signal), 500),
  { concurrency: 3 },
);

console.log('ordered results:', results);
server.close();
