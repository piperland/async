// PIPER ASYNC — release guard tests (hermetic; no network).
// Exercises the pure version/tag/repo logic used by the release workflow.

import { describe, expect, it } from 'vitest';
import {
  assertPrerelease,
  assertRepositoryUrl,
  assertVersionNotPublished,
  deriveBetaTag,
  isPrereleaseVersion,
} from '../scripts/release-guard.mjs';

describe('isPrereleaseVersion', () => {
  it('accepts beta prereleases', () => {
    expect(isPrereleaseVersion('0.1.0-beta.1')).toBe(true);
    expect(isPrereleaseVersion('0.1.0-beta.0')).toBe(true);
  });

  it('rejects stable and malformed versions', () => {
    expect(isPrereleaseVersion('0.1.0')).toBe(false);
    expect(isPrereleaseVersion('0.1.0-beta')).toBe(true); // valid semver prerelease
    expect(isPrereleaseVersion('abc')).toBe(false);
    expect(isPrereleaseVersion('1.2')).toBe(false);
    expect(isPrereleaseVersion('1.2.3')).toBe(false);
    expect(isPrereleaseVersion('')).toBe(false);
    expect(isPrereleaseVersion(null)).toBe(false);
    expect(isPrereleaseVersion(undefined)).toBe(false);
  });
});

describe('assertPrerelease (stable-version guard)', () => {
  it('accepts a future beta prerelease', () => {
    expect(assertPrerelease('0.1.0-beta.1')).toBe('0.1.0-beta.1');
  });

  it('rejects the stable 0.1.0 (must not be publishable via beta workflow)', () => {
    expect(() => assertPrerelease('0.1.0')).toThrow(/not a prerelease/);
  });

  it('rejects malformed versions', () => {
    expect(() => assertPrerelease('nope')).toThrow(/not a prerelease/);
    expect(() => assertPrerelease('1.2.3')).toThrow(/not a prerelease/);
  });
});

describe('deriveBetaTag (prerelease-tag guard)', () => {
  it('maps any beta prerelease to the beta tag, never latest', () => {
    expect(deriveBetaTag('0.1.0-beta.1')).toBe('beta');
    expect(deriveBetaTag('0.1.0-beta.9')).toBe('beta');
  });

  it('refuses to derive a tag for a stable version', () => {
    expect(() => deriveBetaTag('0.1.0')).toThrow();
  });
});

describe('assertVersionNotPublished (existing-version guard)', () => {
  it('accepts a version not on npm', () => {
    expect(assertVersionNotPublished('0.1.0-beta.1', false)).toBe(
      '0.1.0-beta.1',
    );
  });

  it('rejects an already-published version (npm versions are immutable)', () => {
    expect(() => assertVersionNotPublished('0.1.0-beta.0', true)).toThrow(
      /already exists on npm/,
    );
  });
});

describe('assertRepositoryUrl (source check)', () => {
  it('accepts the piperland/async repository', () => {
    expect(assertRepositoryUrl('piperland/async')).toBe('piperland/async');
  });

  it('rejects any other repository', () => {
    expect(() => assertRepositoryUrl('someone/else')).toThrow(
      /refusing release/,
    );
    expect(() => assertRepositoryUrl('')).toThrow(/refusing release/);
  });
});
