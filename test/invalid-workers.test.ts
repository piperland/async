// PIPER ASYNC — invalid-worker adversarial matrix for `race()` (and cross-checks
// against `any()`). A malformed worker entry (eager Promise, null, number,
// object) is programmer error: it must become an authoritative TypeError that a
// legitimate settlement can NEVER mask. No owned work escapes; no unhandled
// rejection.

import { describe, expect, it } from 'vitest';
import { any, race } from '../src/index.js';

const unhandled: unknown[] = [];
function trackUnhandled() {
  const handler = (reason: unknown) => {
    unhandled.push(reason);
  };
  process.on('unhandledRejection', handler);
  return () => process.off('unhandledRejection', handler);
}

const INVALID_MESSAGE =
  'Expected worker to be a function (got a non-function; eager Promises are not workers)';

describe('race — invalid workers are authoritative', () => {
  it('eager Promise first + valid success -> TypeError (not masked)', async () => {
    const e = await race([Promise.resolve('x') as never, async () => 'y']).then(
      () => null,
      (err) => err,
    );
    expect(e).toBeInstanceOf(TypeError);
    expect(e.message).toBe(INVALID_MESSAGE);
  });

  it('valid success + invalid later -> TypeError (invalid cannot be hidden)', async () => {
    const e = await race([async () => 'y', Promise.resolve('x') as never]).then(
      () => null,
      (err) => err,
    );
    expect(e).toBeInstanceOf(TypeError);
  });

  it('null + success -> TypeError', async () => {
    const e = await race([null as never, async () => 'y']).then(
      () => null,
      (err) => err,
    );
    expect(e).toBeInstanceOf(TypeError);
  });

  it('number + success -> TypeError', async () => {
    const e = await race([42 as never, async () => 'y']).then(
      () => null,
      (err) => err,
    );
    expect(e).toBeInstanceOf(TypeError);
  });

  it('object + success -> TypeError', async () => {
    const e = await race([{ a: 1 } as never, async () => 'y']).then(
      () => null,
      (err) => err,
    );
    expect(e).toBeInstanceOf(TypeError);
  });

  it('multiple invalids -> TypeError', async () => {
    const e = await race([null as never, 'str' as never, 42 as never]).then(
      () => null,
      (err) => err,
    );
    expect(e).toBeInstanceOf(TypeError);
  });

  it('eager REJECTED Promise -> observed, no unhandled, still TypeError', async () => {
    const unsub = trackUnhandled();
    const eager = Promise.reject(new Error('already started'));
    const e = await race([eager as never, async () => 'y']).then(
      () => null,
      (err) => err,
    );
    expect(e).toBeInstanceOf(TypeError);
    await new Promise((res) => setTimeout(res, 10));
    expect(unhandled).toEqual([]);
    unsub();
  });
});

describe('cross-check — any and race agree invalid workers are authoritative', () => {
  it('both reject with TypeError for an eager Promise + success', async () => {
    const a = await any([Promise.resolve('x') as never, async () => 'y']).then(
      () => 'resolved',
      (e) => e.constructor.name,
    );
    const r = await race([Promise.resolve('x') as never, async () => 'y']).then(
      () => 'resolved',
      (e) => e.constructor.name,
    );
    expect(a).toBe('TypeError');
    expect(r).toBe('TypeError');
  });

  it('both still work correctly with all-valid workers (no regression)', async () => {
    const a = await any([async () => 'a', async () => 'b']);
    const r = await race([async () => 'a', async () => 'b']);
    expect(['a', 'b']).toContain(a);
    expect(['a', 'b']).toContain(r);
  });
});

describe('ownership — malformed iterable', () => {
  it('iterable is materialized eagerly, so validation rejects BEFORE any worker starts', async () => {
    const unsub = trackUnhandled();
    let started = 0;
    function* mixed() {
      yield async () => {
        started++;
        return 'a';
      };
      yield 42; // invalid entry
    }
    const e = await any(mixed()).then(
      () => null,
      (err) => err,
    );
    expect(e).toBeInstanceOf(TypeError);
    await new Promise((res) => setTimeout(res, 20));
    expect(started).toBe(0); // preferred: no worker starts on invalid input
    expect(unhandled).toEqual([]);
    unsub();
  });
});

describe('randomized — invalid entry at varying indices', () => {
  it('any: malformed entry at any index is always the authoritative TypeError', async () => {
    const unsub = trackUnhandled();
    for (let badIndex = 0; badIndex < 6; badIndex++) {
      const workers = Array.from({ length: 6 }, (_, i) => async () => {
        await new Promise((r) => setTimeout(r, 1));
        return `w${i}`;
      });
      workers[badIndex] = null as never; // inject malformed entry
      const e = await any(workers).then(
        () => null,
        (err) => err,
      );
      expect(e).toBeInstanceOf(TypeError);
    }
    await new Promise((res) => setTimeout(res, 20));
    expect(unhandled).toEqual([]);
    unsub();
  });

  it('race: malformed entry at any index is always the authoritative TypeError', async () => {
    const unsub = trackUnhandled();
    for (let badIndex = 0; badIndex < 6; badIndex++) {
      const workers = Array.from({ length: 6 }, (_, i) => async () => {
        await new Promise((r) => setTimeout(r, 1));
        return `w${i}`;
      });
      workers[badIndex] = 'str' as never;
      const e = await race(workers).then(
        () => null,
        (err) => err,
      );
      expect(e).toBeInstanceOf(TypeError);
    }
    await new Promise((res) => setTimeout(res, 20));
    expect(unhandled).toEqual([]);
    unsub();
  });
});
