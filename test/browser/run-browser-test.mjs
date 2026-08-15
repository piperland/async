// PIPER ASYNC — Playwright runner for browser semantic validation.
// Runs test/browser/browser-semantic.mjs in real headless browsers.
// Usage:
//   node test/browser/run-browser-test.mjs                (default: chromium)
//   node test/browser/run-browser-test.mjs firefox
//   node test/browser/run-browser-test.mjs webkit
//   node test/browser/run-browser-test.mjs all            (all three engines)
//
// Serves the repo root over local HTTP (ES modules need http), loads an HTML
// page that imports the browser-semantic module, and reports the results.

import { readFile } from 'node:fs/promises';
import { createServer } from 'node:http';
import { extname, join, resolve } from 'node:path';
import { chromium, firefox, webkit } from 'playwright';

const ROOT = resolve(import.meta.dirname, '../..');

const ENGINE = process.argv[2] ?? 'chromium';

async function runEngine(browserType, name) {
  const server = serve();
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  const port = server.address().port;
  const url = `http://127.0.0.1:${port}/test/browser/index.html`;
  const browser = await browserType.launch({ headless: true });
  let failed = 0;
  try {
    const page = await browser.newPage();
    page.on('console', (msg) => {
      const text = msg.text();
      if (text.startsWith('BROWSER-SEMANTIC-RESULTS')) {
        const parsed = JSON.parse(
          text.slice('BROWSER-SEMANTIC-RESULTS '.length),
        );
        for (const r of parsed.results) {
          console.log(
            `  [${name}] ${r.ok ? 'ok' : 'FAIL'}: ${r.name}${r.extra ? ` (${r.extra})` : ''}`,
          );
          if (!r.ok) failed++;
        }
        console.log(
          `  [${name}] browser-semantic: ${parsed.results.length - failed} passed, ${failed} failed`,
        );
      }
    });
    page.on('pageerror', (err) => {
      console.error(`  [${name}] browser page error:`, err.message);
      failed++;
    });
    await page.goto(url, { waitUntil: 'networkidle' });
    await page
      .waitForFunction(
        () => {
          return (
            document.body?.dataset?.done === 'true' ||
            document.body?.dataset?.failed === 'true'
          );
        },
        { timeout: 30_000 },
      )
      .catch(() => {});
    await new Promise((r) => setTimeout(r, 500));
  } finally {
    await browser.close();
    server.close();
  }
  return failed === 0;
}

const ENGINES =
  ENGINE === 'all'
    ? { chromium, firefox, webkit }
    : { [ENGINE]: { chromium, firefox, webkit }[ENGINE] };
if (!ENGINES[ENGINE === 'all' ? 'chromium' : ENGINE]) {
  console.error(
    `unknown engine: ${ENGINE} (expected chromium | firefox | webkit | all)`,
  );
  process.exit(2);
}

const MIME = {
  '.html': 'text/html',
  '.js': 'text/javascript',
  '.mjs': 'text/javascript',
  '.json': 'application/json',
  '.map': 'application/json',
};

function serve() {
  return createServer(async (req, res) => {
    try {
      const urlPath = decodeURIComponent(
        new URL(req.url, 'http://localhost').pathname,
      );
      const filePath = join(
        ROOT,
        urlPath === '/' ? 'test/browser/index.html' : urlPath,
      );
      const data = await readFile(filePath);
      res.writeHead(200, {
        'Content-Type': MIME[extname(filePath)] ?? 'application/octet-stream',
        'Cache-Control': 'no-store',
      });
      res.end(data);
    } catch {
      res.writeHead(404);
      res.end('not found');
    }
  });
}

for (const [name, type] of Object.entries(ENGINES)) {
  const nameLabel = ENGINE === 'all' ? name : ENGINE;
  const ok = await runEngine(type, nameLabel);
  if (!ok) process.exitCode = 1;
}
