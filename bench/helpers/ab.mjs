// PIPER ASYNC — A/B comparison helper for optimization validation.
// Runs a scenario fn N times and returns median ops/s + dispersion.
// Used to compare baseline vs candidate across alternating runs.

import { Bench } from 'tinybench';

/**
 * Measure a single scenario, returning { hz (ops/sec median), meanMs, p75Ms }.
 * Uses tinybench with a fixed sample budget.
 */
export async function measureScenario(fn, { label = 'x', iterations = 2000, time = 100 } = {}) {
  const bench = new Bench({ iterations, time });
  bench.add(label, async () => {
    await fn();
  });
  await bench.run();
  const r = bench.tasks[0].result;
  return {
    label,
    hz: r?.hz ?? 0,
    meanMs: r?.mean !== undefined ? r.mean * 1000 : NaN,
    p75Ms: r?.p75 !== undefined ? r.p75 * 1000 : NaN,
  };
}

/**
 * Alternating A/B measurement: runs [A,B,A,B,...] and returns the median of
 * each. Detects JIT/thermal drift.
 */
export async function abCompare(
  labelA,
  fnA,
  labelB,
  fnB,
  { rounds = 5, iterations = 2000, time = 100 } = {},
) {
  const aRuns = [];
  const bRuns = [];
  for (let i = 0; i < rounds; i++) {
    // alternate; warm each once first
    if (i === 0) {
      await fnA();
      await fnB();
    }
    aRuns.push((await measureScenario(fnA, { label: labelA, iterations, time })).hz);
    bRuns.push((await measureScenario(fnB, { label: labelB, iterations, time })).hz);
  }
  const median = (arr) => {
    const s = [...arr].sort((x, y) => x - y);
    return s[Math.floor(s.length / 2)];
  };
  const aMed = median(aRuns);
  const bMed = median(bRuns);
  const deltaPct = aMed === 0 ? NaN : ((bMed - aMed) / aMed) * 100;
  console.log(
    `${labelA}: median ${aMed.toFixed(0)} ops/s  ${labelB}: median ${bMed.toFixed(0)} ops/s  delta ${deltaPct.toFixed(1)}%`,
  );
  return { aMedian: aMed, bMedian: bMed, deltaPct, aRuns, bRuns };
}
