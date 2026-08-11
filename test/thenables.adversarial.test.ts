// The thenable factories below deliberately define a `then` property; they
// exist to test hostile/unusual thenables, so the `noThenProperty` rule does
// not apply in this file.
// biome-ignore-all lint/suspicious/noThenProperty: intentional thenable torture
import { describe, expect, it } from 'vitest';
import { map, race, retry, scope, timeout } from '../src/index.js';
import { tick, trackUnhandledRejections } from './helpers/adversarial.js';

// ---- Hostile thenable factories ----
function syncResolveThenable<T>(v: T): PromiseLike<T> {
  return {
    then(res) {
      res(v);
      return Promise.resolve(v);
    },
  } as PromiseLike<T>;
}

function syncRejectThenable<T>(e: unknown): PromiseLike<T> {
  return {
    then(_res, rej) {
      rej(e);
      return Promise.resolve(); // a well-behaved thenable: reject once
    },
  } as PromiseLike<T>;
}

function doubleResolveThenable<T>(v: T): PromiseLike<T> {
  return {
    then(res) {
      res(v);
      res(v); // second resolve ignored by Promise assimilation
      return Promise.resolve(v);
    },
  } as PromiseLike<T>;
}

function rejectAfterResolveThenable<T>(v: T, e: unknown): PromiseLike<T> {
  return {
    then(res, rej) {
      res(v);
      rej(e); // reject after resolve → ignored
      return Promise.resolve(v);
    },
  } as PromiseLike<T>;
}

function throwFromThen<T>(): PromiseLike<T> {
  return {
    then() {
      throw new Error('then-throws');
    },
  } as PromiseLike<T>;
}

function resolveThenThrowThenable<T>(v: T): PromiseLike<T> {
  return {
    then(res) {
      res(v);
      throw new Error('throw-after-resolve');
    },
  } as PromiseLike<T>;
}

describe('thenable torture', () => {
  it('spawn: sync-resolve thenable', async () => {
    await scope(async (s) => {
      const r = await s.spawn(() => syncResolveThenable('ok'));
      expect(r).toBe('ok');
    });
  });

  it('spawn: sync-reject thenable', async () => {
    const stop = trackUnhandledRejections();
    try {
      await expect(
        scope(async (s) => {
          s.spawn(() => syncRejectThenable(new Error('rej')));
        }),
      ).rejects.toThrow('rej');
      await tick();
      expect(stop.observed).toHaveLength(0);
    } finally {
      stop.stop();
    }
  });

  it('spawn: double-resolve thenable → settled once', async () => {
    await scope(async (s) => {
      const r = await s.spawn(() => doubleResolveThenable('once'));
      expect(r).toBe('once');
    });
  });

  it('spawn: reject-after-resolve thenable → resolve wins', async () => {
    await scope(async (s) => {
      const r = await s.spawn(() =>
        rejectAfterResolveThenable('v', new Error('late')),
      );
      expect(r).toBe('v');
    });
  });

  it('spawn: then() throws → rejects with that error, observed', async () => {
    const stop = trackUnhandledRejections();
    try {
      await expect(
        scope(async (s) => {
          s.spawn(() => throwFromThen());
        }),
      ).rejects.toThrow('then-throws');
      await tick();
      expect(stop.observed).toHaveLength(0);
    } finally {
      stop.stop();
    }
  });

  it('spawn: resolve-then-throw thenable → resolve wins, throw observed', async () => {
    const stop = trackUnhandledRejections();
    try {
      await scope(async (s) => {
        const r = await s.spawn(() => resolveThenThrowThenable('v'));
        expect(r).toBe('v');
      });
      await tick();
      expect(stop.observed).toHaveLength(0);
    } finally {
      stop.stop();
    }
  });

  it('retry: sync-reject thenable is retryable', async () => {
    let calls = 0;
    const r = await retry(() => {
      calls++;
      if (calls === 1) return syncRejectThenable(new Error('first'));
      return 'ok';
    });
    expect(calls).toBe(2);
    expect(r).toBe('ok');
  });

  it('timeout: sync-resolve thenable wins before deadline', async () => {
    const r = await timeout(() => syncResolveThenable('fast'), 1000);
    expect(r).toBe('fast');
  });

  it('race: sync-resolve thenable competitor', async () => {
    const r = await race([
      () => syncResolveThenable('t1'),
      async () => {
        await new Promise((res) => setTimeout(res, 20));
        return 'slow';
      },
    ]);
    expect(r).toBe('t1');
  });

  it('map: sync-reject thenable mapper → fail-fast', async () => {
    const stop = trackUnhandledRejections();
    try {
      await expect(
        map(
          [1, 2, 3],
          (x) => (x === 2 ? syncRejectThenable(new Error('map-rej')) : x),
          { concurrency: 2 },
        ),
      ).rejects.toThrow('map-rej');
      await tick();
      expect(stop.observed).toHaveLength(0);
    } finally {
      stop.stop();
    }
  });

  it('map: sync-resolve thenable mapper', async () => {
    const r = await map([1, 2], (x) => syncResolveThenable(x * 10), {
      concurrency: 2,
    });
    expect(r).toEqual([10, 20]);
  });
});

describe('weird worker return values', () => {
  it('workers returning undefined/null/0/false/object behave naturally', async () => {
    await scope(async (s) => {
      expect(await s.spawn(() => undefined)).toBeUndefined();
      expect(await s.spawn(() => null)).toBeNull();
      expect(await s.spawn(() => 0)).toBe(0);
      expect(await s.spawn(() => false)).toBe(false);
      expect(await s.spawn(() => ({ a: 1 }))).toEqual({ a: 1 });
    });
    await expect(retry(() => undefined)).resolves.toBeUndefined();
    await expect(timeout(() => null, 1000)).resolves.toBeNull();
  });
});

describe('multiple consumers of returned Promise', () => {
  it('spawn result: await + catch + Promise.all all work', async () => {
    await scope(async (s) => {
      const p = s.spawn(async () => 42);
      const a = await p;
      const b = await p.then((v) => v + 1);
      const [c] = await Promise.all([p]);
      expect(a).toBe(42);
      expect(b).toBe(43);
      expect(c).toBe(42);
    });
  });

  it('spawn rejection: multiple catches each observe once', async () => {
    const stop = trackUnhandledRejections();
    try {
      await expect(
        scope(async (s) => {
          const p = s.spawn(async () => {
            throw new Error('multi');
          });
          p.catch(() => {}); // extra consumer
          await p.catch(() => {});
        }),
      ).rejects.toThrow('multi');
      await tick();
      expect(stop.observed).toHaveLength(0);
    } finally {
      stop.stop();
    }
  });

  it('timeout result consumed by multiple awaits', async () => {
    const p = timeout(async () => 7, 1000);
    expect(await p).toBe(7);
    expect(await p).toBe(7); // promises are memoized
  });

  it('race result consumed by multiple awaits', async () => {
    const p = race([async () => 'w', async () => 'x']);
    expect(await p).toBeDefined();
    expect(await p).toBe(await p);
  });
});
