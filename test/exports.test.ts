import { describe, expect, it } from 'vitest';
import * as api from '../src/index.js';

describe('public API exports', () => {
  it('exposes scope, retry, timeout, race, map as runtime exports', () => {
    expect(typeof api.scope).toBe('function');
    expect(typeof api.retry).toBe('function');
    expect(typeof api.timeout).toBe('function');
    expect(typeof api.race).toBe('function');
    expect(typeof api.map).toBe('function');
  });

  it('does NOT expose spawn, Task, Context, Awaitable, Deadline as runtime exports', () => {
    const keys = Object.keys(api);
    expect(keys).not.toContain('spawn');
    expect(keys).not.toContain('Task');
    expect(keys).not.toContain('Context');
    expect(keys).not.toContain('Awaitable');
    expect(keys).not.toContain('Deadline');
    expect(keys).not.toContain('TaskHandle');
    expect(keys).not.toContain('CancellationToken');
    expect(keys).not.toContain('any');
  });

  it('exports ONLY the intended runtime functions', () => {
    const keys = Object.keys(api).sort();
    expect(keys).toEqual(['map', 'race', 'retry', 'scope', 'timeout']);
  });
});
