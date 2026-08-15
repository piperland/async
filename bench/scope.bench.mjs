// PIPER ASYNC — scope benchmark.
// No direct p-* analogue exists, so we build a hand-written native equivalent
// baseline implementing: AbortController, child tracking, fail-fast
// cancellation, await teardown, first-failure. This answers: what overhead
// does the Piper abstraction add over writing the semantics manually?
//
// Semantic notes:
//  - Scope A (empty control): DIRECT overhead vs a bare async IIFE.
//  - Scope B (one owned child): vs raw Promise.resolve floor AND a manual
//    native ownership baseline.
//  - Scope C (N parallel children): vs Promise.all (raw floor, weaker
//    semantics) and manual fail-fast baseline.
//  - Scope D (failure cleanup): behavioral settle-time.

import { scope } from '../dist/index.js';
import { createBench, runBench } from './helpers/harness.mjs';

// Manual native scope baseline with fail-fast + teardown.
async function manualScope(callback, { signal } = {}) {
  const controller = new AbortController();
  const effective = signal ? AbortSignal.any([controller.signal, signal]) : controller.signal;
  const children = new Set();
  let firstError;
  const s = {
    signal: effective,
    spawn(fn) {
      if (effective.aborted) throw new TypeError('closed');
      const p = Promise.resolve().then(() => fn(effective));
      p.catch((e) => {
        if (firstError === undefined && !effective.aborted) {
          firstError = e;
          controller.abort(e);
        }
      });
      p.catch(() => {});
      children.add(p);
      p.then(() => children.delete(p), () => children.delete(p));
      return p;
    },
  };
  let result;
  try {
    result = await callback(s);
  } catch (e) {
    controller.abort(e);
    await Promise.allSettled([...children]);
    throw firstError ?? e;
  }
  while (children.size) await Promise.allSettled([...children]);
  return result;
}

async function scopeEmpty() {
  const bench = createBench();
  bench.add('piper scope (empty)', async () => {
    await scope(async () => {});
  });
  bench.add('bare async IIFE (empty)', async () => {
    await (async () => {})();
  });
  await runBench(bench, 'scope A empty control');
}

async function scopeOneChild() {
  const bench = createBench();
  bench.add('piper scope 1 spawn', async () => {
    await scope(async (s) => s.spawn(() => 1));
  });
  bench.add('manual native scope 1 spawn', async () => {
    await manualScope(async (s) => s.spawn(() => 1));
  });
  bench.add('Promise.resolve floor', async () => {
    await Promise.resolve(1);
  });
  await runBench(bench, 'scope B one owned child');
}

async function scopeNChildren() {
  const bench = createBench();
  for (const n of [8, 32, 128]) {
    bench.add(`piper scope ${n} spawn`, async () => {
      await scope(async (s) => {
        const ps = [];
        for (let i = 0; i < n; i++) ps.push(s.spawn(() => i));
        await Promise.all(ps);
      });
    });
    bench.add(`manual scope ${n} spawn`, async () => {
      await manualScope(async (s) => {
        const ps = [];
        for (let i = 0; i < n; i++) ps.push(s.spawn(() => i));
        await Promise.all(ps);
      });
    });
    bench.add(`Promise.all ${n}`, async () => {
      const ps = [];
      for (let i = 0; i < n; i++) ps.push(Promise.resolve(i));
      await Promise.all(ps);
    });
  }
  await runBench(bench, 'scope C N parallel children');
}

async function scopeFailure() {
  console.log('\n=== scope D failure cleanup (behavioral) ===');
  for (const impl of ['piper', 'manual']) {
    const input = Array.from({ length: 50 }, (_, i) => i);
    const t0 = performance.now();
    let rejected = false;
    try {
      const run = impl === 'piper' ? scope : manualScope;
      await run(async (s) => {
        for (const x of input) {
          s.spawn(async (signal) => {
            if (x === 25) throw new Error('fail');
            await new Promise((r) => setTimeout(r, 2));
            return x;
          });
        }
        await new Promise((r) => setTimeout(r, 2));
      });
    } catch {
      rejected = true;
    }
    const dt = performance.now() - t0;
    console.log(`  ${impl}: rejected=${rejected} settleTime=${dt.toFixed(1)}ms`);
  }
}

await scopeEmpty();
await scopeOneChild();
await scopeNChildren();
await scopeFailure();
