// PIPER ASYNC — benchmark harness wrapper around tinybench.
// Provides warmup, multiple samples, async benchmarks, JSON export.
// Benchmark-only code; imports the BUILT package output.

import { Bench } from 'tinybench';
import { writeFileSync, mkdirSync } from 'node:fs';
import { dirname, join } from 'node:path';

export const RESULT_DIR = join(import.meta.dirname, '../../.agent/benchmarks/results');

/**
 * Create a bench with shared warmup.
 * Each scenario is a { name, fn } where fn does setup + timed work + returns a
 * verification value. Verification runs OUTSIDE the timed region.
 */
export function createBench({ warmup = 2, samples = 10, iterations = 1000 } = {}) {
  const bench = new Bench({
    time: 50, // min time per sample (ms)
    iterations, // min iterations per sample
    warmupTime: 100,
    warmupIterations: warmup * 100,
  });
  return bench;
}

/** Add a scenario with verification. `setup` is excluded from timing. */
export function addScenario(bench, name, { setup = () => {}, run, verify }) {
  bench.add(name, async () => {
    const ctx = setup();
    const result = await run(ctx);
    if (verify) verify(ctx, result);
    return result;
  });
}

/** Run the bench, print per-task results, and save JSON. */
export async function runBench(bench, label, { save = true } = {}) {
  await bench.run();
  const rows = [];
  console.log(`\n=== ${label} ===`);
  for (const task of bench.tasks) {
    const r = task.result;
    const name = task.name;
    const hz = r?.hz ?? 0; // ops/sec
    const meanMs = r?.mean !== undefined ? r.mean * 1000 : NaN;
    const p75Ms = r?.p75 !== undefined ? r.p75 * 1000 : NaN;
    const p99Ms = r?.p99 !== undefined ? r.p99 * 1000 : NaN;
    const samples = r?.samples?.length ?? 0;
    rows.push({ name, hz, meanMs, p75Ms, p99Ms, samples });
    console.log(
      `${name.padEnd(46)} ${String(hz.toFixed(0)).padStart(12)} ops/s  mean=${fmtMs(meanMs)}  p75=${fmtMs(p75Ms)}  p99=${fmtMs(p99Ms)}  n=${samples}`,
    );
  }
  if (save) {
    mkdirSync(RESULT_DIR, { recursive: true });
    const file = join(RESULT_DIR, `${slugify(label)}.json`);
    writeFileSync(file, JSON.stringify({ label, rows, runAt: new Date().toISOString() }, null, 2));
    console.log(`saved: ${file}`);
  }
  return bench;
}

function fmtMs(ms) {
  if (Number.isNaN(ms)) return '?';
  return ms >= 1 ? `${ms.toFixed(1)}ms` : `${(ms * 1000).toFixed(0)}µs`;
}

function slugify(s) {
  return s.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '');
}

/** Environment fingerprint for results. */
export function envFingerprint() {
  return {
    node: process.version,
    platform: process.platform,
    arch: process.arch,
    cpus: osCpuModel(),
    cpusLogical: osCpuCount(),
    commit: gitHead(),
  };
}

function osCpuModel() {
  const os = require('node:os');
  const cpus = os.cpus();
  return cpus.length ? `${cpus[0].model} (${cpus.length})` : 'unknown';
}
function osCpuCount() {
  const os = require('node:os');
  return os.cpus().length;
}
function gitHead() {
  try {
    const { execSync } = require('node:child_process');
    return execSync('git rev-parse --short HEAD').toString().trim();
  } catch {
    return 'unknown';
  }
}
