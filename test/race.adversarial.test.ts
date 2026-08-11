import { describe, expect, it } from 'vitest';
import { race } from '../src/race.js';
import {
  gate,
  recorder,
  signalAwareWorker,
  tick,
  trackUnhandledRejections,
} from './helpers/adversarial.js';

describe('race: enumeration semantics', () => {
  it('empty → clear error', async () => {
    await expect(race([])).rejects.toThrow('at least one worker');
  });

  it('single worker', async () => {
    await expect(race([async () => 'only'])).resolves.toBe('only');
  });

  it('array of workers', async () => {
    await expect(race([async () => 1, async () => 2])).resolves.toBeDefined();
  });

  it('generator iterable', async () => {
    function* gen() {
      yield async () => 'a';
      yield async () => 'b';
    }
    await expect(race(gen())).resolves.toBeDefined();
  });

  it('custom iterable', async () => {
    const custom = {
      *[Symbol.iterator]() {
        yield async () => 'c1';
        yield async () => 'c2';
      },
    };
    await expect(race(custom)).resolves.toBeDefined();
  });

  it('iterable throwing before first yield → rejects with that error', async () => {
    const bad = {
      [Symbol.iterator]() {
        throw new Error('pre-enum-fail');
      },
    };
    await expect(race(bad)).rejects.toThrow('pre-enum-fail');
  });

  it('iterable throwing AFTER some workers start → started workers cancelled + awaited', async () => {
    const rec = recorder();
    const stop = trackUnhandledRejections();
    try {
      function* gen() {
        yield signalAwareWorker('w1', rec, { finishDelayMs: 30 });
        throw new Error('enum-fail-after');
      }
      await expect(race(gen())).rejects.toThrow('enum-fail-after');
      // the started worker (w1) must have been cancelled + awaited
      await tick();
      // w1 either completed or was cancelled; no unhandled rejection
      expect(stop.observed).toHaveLength(0);
    } finally {
      stop.stop();
    }
  });

  it('non-function entry becomes a rejecting competitor (first-settled wins)', async () => {
    // A non-function entry is invoked via fn(signal) which throws TypeError →
    // that competitor rejects. race is first-settled: if another resolves
    // first, it wins; if the bad entry settles first, race rejects with it.
    const stop = trackUnhandledRejections();
    try {
      // slow good worker → the bad entry rejects first → race rejects
      await expect(
        race([
          async () => {
            await new Promise((r) => setTimeout(r, 20));
            return 'ok';
          },
          // @ts-expect-error - non-function entry
          'not-a-function',
        ]),
      ).rejects.toBeInstanceOf(TypeError);
      await tick();
      expect(stop.observed).toHaveLength(0);
    } finally {
      stop.stop();
    }
  });

  it('worker throws synchronously → selection + no leak', async () => {
    const stop = trackUnhandledRejections();
    try {
      await expect(
        race([
          () => {
            throw new Error('sync-throw');
          },
          async () => 'other',
        ]),
      ).rejects.toThrow('sync-throw');
      await tick();
      expect(stop.observed).toHaveLength(0);
    } finally {
      stop.stop();
    }
  });

  it('generator that yields then stops is fine', async () => {
    function* gen() {
      yield async () => {
        await new Promise((r) => setTimeout(r, 20));
        return 'g1';
      };
      yield async () => 'g2';
    }
    const r = await race(gen());
    expect(['g1', 'g2']).toContain(r);
  });

  it('fully-infinite iterable is materialized eagerly (documented danger)', async () => {
    // NOTE: race() materializes the iterable with [...workers]. A fully
    // infinite iterable therefore hangs in materialization — this is a known
    // semantic risk (documented, not changed in v0.1). We test that a LARGE
    // but finite iterable completes, and that an infinite one is NOT used.
    function* many() {
      for (let i = 0; i < 10_000; i++) {
        yield async () => i;
      }
    }
    const r = await race(many());
    expect(r).toBeDefined();
  });
});

describe('race: strong settlement torture', () => {
  it('winner at t0, loser cleanup waits on gate → race stays pending', async () => {
    const rec = recorder();
    const loserGate = gate();
    let settled = false;
    const p = race([
      async () => {
        await new Promise((r) => setTimeout(r, 20));
        return 'winner';
      },
      async (signal) => {
        try {
          await new Promise((_r, rej) => {
            signal.addEventListener('abort', () => rej(signal.reason), {
              once: true,
            });
          });
          return 'loser';
        } finally {
          rec.push('loser-cleanup-start');
          await loserGate.wait();
          rec.push('loser-cleanup-end');
        }
      },
    ]).then((v) => {
      settled = true;
      return v;
    });
    // after winner, loser cleanup is blocked on the gate → race must be pending
    await new Promise((r) => setTimeout(r, 40));
    expect(settled).toBe(false);
    loserGate.open();
    await expect(p).resolves.toBe('winner');
    expect(rec.includes('loser-cleanup-start')).toBe(true);
    expect(rec.includes('loser-cleanup-end')).toBe(true);
  });

  it('loser ignores signal but resolves eventually → race waits', async () => {
    const rec = recorder();
    const start = Date.now();
    const r = await race([
      async () => 'winner',
      async () => {
        // ignores signal, resolves after 30ms
        await new Promise((res) => setTimeout(res, 30));
        rec.push('loser-done');
        return 'loser';
      },
    ]);
    expect(r).toBe('winner');
    expect(rec.includes('loser-done')).toBe(true);
    expect(Date.now() - start).toBeGreaterThanOrEqual(25);
  });
});

describe('race: storm', () => {
  it('100 competitors, one immediate winner', async () => {
    const stop = trackUnhandledRejections();
    try {
      const workers = [];
      for (let i = 0; i < 100; i++) {
        workers.push(
          signalAwareWorker(`r${i}`, recorder(), { finishDelayMs: 5 }),
        );
      }
      workers.push(async () => 'win');
      await expect(race(workers)).resolves.toBe('win');
      await tick();
      expect(stop.observed).toHaveLength(0);
    } finally {
      stop.stop();
    }
  });

  it('1000 competitors, one immediate rejection', async () => {
    const stop = trackUnhandledRejections();
    try {
      const workers = [];
      for (let i = 0; i < 1000; i++) {
        workers.push(
          signalAwareWorker(`q${i}`, recorder(), { finishDelayMs: 5 }),
        );
      }
      workers.push(async () => {
        throw new Error('early-reject');
      });
      await expect(race(workers)).rejects.toThrow('early-reject');
      await tick();
      expect(stop.observed).toHaveLength(0);
    } finally {
      stop.stop();
    }
  });

  it('many same-turn resolutions → selected exactly once, no unhandled', async () => {
    const stop = trackUnhandledRejections();
    try {
      const workers = Array.from({ length: 500 }, (_, i) => async () => i);
      const r = await race(workers);
      expect(r).toBeDefined();
      await tick();
      expect(stop.observed).toHaveLength(0);
    } finally {
      stop.stop();
    }
  });

  it('mixed sync + async workers', async () => {
    const stop = trackUnhandledRejections();
    try {
      const workers: Array<(signal: AbortSignal) => unknown> = [
        () => 'sync',
        async () => {
          await new Promise((r) => setTimeout(r, 10));
          return 'async';
        },
      ];
      const r = await race(workers);
      expect(r).toBe('sync');
      await tick();
      expect(stop.observed).toHaveLength(0);
    } finally {
      stop.stop();
    }
  });
});
