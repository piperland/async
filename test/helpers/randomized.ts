// Randomized scheduling harness for Piper adversarial testing.
// Seeded + deterministic given seed; records + can replay failing seeds.
// Test-only machinery.

import { mulberry32, type Rng, deferred, recorder } from './adversarial.js';

export type RandomSeed = number;

export interface RandomRunResult {
  seed: number;
  events: string[];
  unhandled: unknown[];
  error: unknown | undefined;
}

/**
 * A tiny randomized scenario runner.
 *
 * The `actions` list is shuffled deterministically by the seed; each action is
 * executed with the rng available. `build` sets up the scenario and returns a
 * promise that resolves when the scenario settles.
 */
export async function runRandomScenario(
  seed: RandomSeed,
  build: (
    ctx: {
      rng: Rng;
      rec: { push: (e: string) => void };
      deferred: typeof deferred;
      events: string[];
    },
  ) => Promise<void>,
  opts: { timeoutMs?: number } = {},
): Promise<RandomRunResult> {
  const rng = mulberry32(seed);
  const rec = recorder();
  const unhandled: unknown[] = [];
  const onUnhandled = (reason: unknown) => {
    unhandled.push(reason);
  };
  process.on('unhandledRejection', onUnhandled);

  let error: unknown;
  const ctx = { rng, rec, deferred, events: rec.events };
  const timeoutMs = opts.timeoutMs ?? 5000;
  try {
    const done = build(ctx);
    const result = await Promise.race([
      done,
      new Promise<never>((_, rej) =>
        setTimeout(() => rej(new Error(`scenario timeout (seed ${seed})`)), timeoutMs),
      ),
    ]);
    await result;
  } catch (e) {
    error = e;
  } finally {
    process.off('unhandledRejection', onUnhandled);
  }
  return { seed, events: rec.events, unhandled, error };
}

/** Run many seeds, returning failures. */
export async function runManyRandom(
  build: (ctx: {
    rng: Rng;
    rec: { push: (e: string) => void };
    deferred: typeof deferred;
    events: string[];
  }) => Promise<void>,
  seedCount: number,
  opts: { baseSeed?: number; timeoutMs?: number } = {},
): Promise<RandomRunResult[]> {
  const base = opts.baseSeed ?? 1;
  const failures: RandomRunResult[] = [];
  for (let i = 0; i < seedCount; i++) {
    const r = await runRandomScenario(base + i, build, opts);
    if (r.error !== undefined || r.unhandled.length > 0) {
      failures.push(r);
    }
  }
  return failures;
}
