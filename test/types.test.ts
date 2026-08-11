import { expectTypeOf } from 'expect-type';
import { describe, it } from 'vitest';
import type { Scope } from '../src/index.js';
import { map, race, retry, scope, timeout } from '../src/index.js';

// These tests only type-check; expectTypeOf asserts exact inferred types.
describe('type system', () => {
  it('Scope type is importable and has spawn + signal', () => {
    const s = {} as Scope;
    expectTypeOf(s.signal).toEqualTypeOf<AbortSignal>();
    expectTypeOf(s.spawn).toBeFunction();
  });

  it('spawn accepts zero-arg async worker', async () => {
    await scope(async (s) => {
      const r = s.spawn(async () => 42);
      expectTypeOf(r).toEqualTypeOf<Promise<number>>();
    });
  });

  it('spawn accepts zero-arg sync worker', async () => {
    await scope(async (s) => {
      const r = s.spawn(() => 42);
      expectTypeOf(r).toEqualTypeOf<Promise<number>>();
    });
  });

  it('spawn accepts signal-aware worker', async () => {
    await scope(async (s) => {
      const r = s.spawn(async (signal) => {
        void signal;
        return 'ok';
      });
      expectTypeOf(r).toEqualTypeOf<Promise<string>>();
    });
  });

  it('map infers item and result types', async () => {
    const r = await map([1, 2, 3], async (item) => item * 2, {
      concurrency: 2,
    });
    expectTypeOf(r).toEqualTypeOf<Promise<number[]>>();
  });

  it('map accepts (item, index) mapper', async () => {
    const r = await map(['a', 'b'], async (item, index) => item + index, {
      concurrency: 1,
    });
    expectTypeOf(r).toEqualTypeOf<Promise<string[]>>();
  });

  it('map accepts (item, index, signal) mapper', async () => {
    const r = await map(
      ['a', 'b'],
      async (item, index, signal) => item + index + (signal.aborted ? '!' : ''),
      { concurrency: 1 },
    );
    expectTypeOf(r).toEqualTypeOf<Promise<string[]>>();
  });

  it('retry infers result type', async () => {
    const r = await retry(async () => 'ok');
    expectTypeOf(r).toEqualTypeOf<Promise<string>>();
  });

  it('timeout infers result type', async () => {
    const r = await timeout(async () => 7, 100);
    expectTypeOf(r).toEqualTypeOf<Promise<number>>();
  });

  it('race infers union of worker results', async () => {
    const r = await race([async () => 'a', async () => 1]);
    expectTypeOf(r).toEqualTypeOf<Promise<string | number>>();
  });

  // These verify compile-time rejection WITHOUT running the eager-promise code:
  // the functions are declared but never invoked, so tsc checks the @ts-expect-error
  // while runtime never executes the invalid call.
  it('eager promise is rejected at compile time', () => {
    const rejectsEager = (s: Scope) => {
      // @ts-expect-error - an already-started Promise is not a worker
      s.spawn(Promise.resolve(1));
    };
    void rejectsEager;
  });

  it('eager promise is rejected for retry', () => {
    // @ts-expect-error - an already-started Promise is not a worker
    const r = (fn: typeof retry) => fn(Promise.resolve(1));
    void r;
  });

  it('no public lazy Task wrapper type', () => {
    // @ts-expect-error - Task is not exported
    expectTypeOf<import('../src/index.js').Task>().toBeNever();
  });

  // ---- API-surface regression tests (v0.1 public types) ----
  // Only `Scope` is a public package type. The option interfaces are NOT
  // importable from the package entry point. These are never executed, so the
  // @ts-expect-error annotations verify compile-time rejection only.
  it('only Scope is importable as a public type', () => {
    type S = import('../src/index.js').Scope;
    expectTypeOf<S>().toBeObject();
  });

  it('ScopeOptions is not a public package type', () => {
    // @ts-expect-error - ScopeOptions must not be importable from the entry point
    type T = import('../src/index.js').ScopeOptions;
    void (null as T | null);
  });

  it('RetryOptions is not a public package type', () => {
    // @ts-expect-error - RetryOptions must not be importable from the entry point
    type T = import('../src/index.js').RetryOptions;
    void (null as T | null);
  });

  it('TimeoutOptions is not a public package type', () => {
    // @ts-expect-error - TimeoutOptions must not be importable from the entry point
    type T = import('../src/index.js').TimeoutOptions;
    void (null as T | null);
  });

  it('RaceOptions is not a public package type', () => {
    // @ts-expect-error - RaceOptions must not be importable from the entry point
    type T = import('../src/index.js').RaceOptions;
    void (null as T | null);
  });

  it('MapOptions is not a public package type', () => {
    // @ts-expect-error - MapOptions must not be importable from the entry point
    type T = import('../src/index.js').MapOptions;
    void (null as T | null);
  });

  // Structural inference must be preserved even without the named option types.
  it('retry options are structurally inferred without a named type', async () => {
    const r = await retry(async () => 'ok', {
      attempts: 3,
      delay: 10,
      signal: new AbortController().signal,
    });
    expectTypeOf(r).toEqualTypeOf<Promise<string>>();
  });

  it('timeout options are structurally inferred without a named type', async () => {
    const r = await timeout(async () => 1, 100, {
      signal: new AbortController().signal,
    });
    expectTypeOf(r).toEqualTypeOf<Promise<number>>();
  });

  it('map options are structurally inferred without a named type', async () => {
    const r = await map([1, 2], async (x) => x, { concurrency: 2 });
    expectTypeOf(r).toEqualTypeOf<Promise<number[]>>();
  });

  it('scope options are structurally inferred without a named type', async () => {
    const r = await scope(async () => 'ok', {
      signal: new AbortController().signal,
    });
    expectTypeOf(r).toEqualTypeOf<Promise<string>>();
  });
});
