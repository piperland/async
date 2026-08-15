// PIPER ASYNC — Playwright runner for browser semantic validation.
// Runs test/browser/browser-semantic.mjs in real headless Chromium.
// Usage: node test/browser/run-browser-test.mjs
//
// Serves the repo root over local HTTP (ES modules need http), loads an HTML
// page that imports the browser-semantic module, and reports the results.

import { createServer } from 'node:http';
import { readFile } from 'node:fs/promises';
import { extname, join, resolve } from 'node:path';
import { chromium } from 'playwright';

const ROOT = resolve(import.meta.dirname, '../..');

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
      const urlPath = decodeURIComponent(new URL(req.url, 'http://localhost').pathname);
      const filePath = join(ROOT, urlPath === '/' ? 'test/browser/index.html' : urlPath);
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

const server = serve();
await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
const port = server.address().port;
const url = `http://127.0.0.1:${port}/test/browser/index.html`;

const browser = await chromium.launch({ headless: true });
try {
  const page = await browser.newPage();
  page.on('console', (msg) => {
    const text = msg.text();
    if (text.startsWith('BROWSER-SEMANTIC-RESULTS')) {
      const parsed = JSON.parse(text.slice('BROWSER-SEMANTIC-RESULTS '.length));
      let failed = 0;
      for (const r of parsed.results) {
        console.log(`  ${r.ok ? 'ok' : 'FAIL'}: ${r.name}${r.extra ? ` (${r.extra})` : ''}`);
        if (!r.ok) failed++;
      }
      console.log(`browser-semantic: ${parsed.results.length - failed} passed, ${failed} failed`);
      process.exitCode = failed > 0 ? 1 : 0;
    }
  });
  page.on('pageerror', (err) => {
    console.error('browser page error:', err.message);
    process.exitCode = 1;
  });
  await page.goto(url, { waitUntil: 'networkidle' });
  // give the module time to run and report
  await page.waitForFunction(() => {
    return document.body?.dataset?.done === 'true' || document.body?.dataset?.failed === 'true';
  }, { timeout: 30_000 }).catch(() => {
    // page may have closed
  });
  await new Promise((r) => setTimeout(r, 500));
} finally {
  await browser.close();
  server.close();
}
