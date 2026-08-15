// Piper Async — release guard (tiny, testable).
//
// Pure version/tag/repo logic + an optional live-registry existence check.
// Used by .github/workflows/publish.yml (release guards step) and by the
// `pnpm release:check` prep script. It NEVER publishes anything.
//
// Pure functions are imported directly by test/release-guard.test.ts (hermetic,
// no network). The registry existence check only runs when explicitly enabled.

import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { pathToFileURL } from 'node:url';

import { dirname, join } from 'node:path';

const run = promisify(execFile);

// Resolve the `npm` executable without a shell (shell:true triggers DEP0190).
//   - Windows: `npm` is a .cmd shim that execFile cannot spawn directly
//     (EINVAL); invoke the real cli.js with the current Node instead.
//   - POSIX (CI): plain `npm` works.
function npmInvocation() {
  if (process.platform === 'win32') {
    const npmCli = join(dirname(process.execPath), 'node_modules', 'npm', 'bin', 'npm-cli.js');
    return { bin: process.execPath, args: [npmCli] };
  }
  return { bin: 'npm', args: [] };
}

/** Does `version` carry a prerelease component (e.g. 0.1.0-beta.1)? */
export function isPrereleaseVersion(version) {
  return typeof version === 'string' && /^[0-9]+\.[0-9]+\.[0-9]+-.+/.test(version);
}

/** Beta phase: only prerelease versions may be released. Rejects stable 0.1.0. */
export function assertPrerelease(version) {
  if (!isPrereleaseVersion(version)) {
    throw new Error(
      `refusing version '${version}': not a prerelease (beta-phase workflow allows prerelease only)`,
    );
  }
  return version;
}

/** v0.1 beta channel: any prerelease publishes under the `beta` tag, never `latest`. */
export function deriveBetaTag(version) {
  assertPrerelease(version);
  return 'beta';
}

/** Versions on npm are immutable — never republish. */
export function assertVersionNotPublished(version, exists) {
  if (exists) {
    throw new Error(
      `refusing to publish '${version}': already exists on npm (versions are immutable)`,
    );
  }
  return version;
}

/** The release workflow only runs for the piperland/async source repository. */
export function assertRepositoryUrl(repository) {
  const expected = 'piperland/async';
  if (repository !== expected) {
    throw new Error(`refusing release from '${repository}' (expected ${expected})`);
  }
  return repository;
}

/** Query the live npm registry for `@piperland/async@version`. */
export async function versionExistsOnRegistry(version) {
  try {
    const { bin, args } = npmInvocation();
    const { stdout } = await run(bin, [
      ...args,
      'view',
      `@piperland/async@${version}`,
      'version',
      '--json',
    ]);
    const trimmed = stdout.trim();
    if (!trimmed || trimmed === '[]') return false;
    const parsed = JSON.parse(trimmed);
    return Array.isArray(parsed) ? parsed.length > 0 : Boolean(parsed);
  } catch {
    // `npm view <pkg>@<v> version` exits non-zero when the version does not exist.
    return false;
  }
}

/**
 * Full guard. `--no-registry` may appear anywhere and skips the live existence
 * check (CI uses the live check; local prep uses --no-registry).
 *
 * With no version argument, reads it from the local package.json (used by
 * `pnpm release:check`, avoiding fragile shell command substitution).
 */
export async function main(argv) {
  const noRegistry = argv.includes('--no-registry');
  const positionals = argv.filter((a) => a !== '--no-registry');
  const [maybeVersion, repository] = positionals;
  let version = maybeVersion;
  if (!version) {
    const { readFileSync } = await import('node:fs');
    version = JSON.parse(readFileSync(new URL('../package.json', import.meta.url), 'utf8')).version;
  }
  assertPrerelease(version);
  if (repository) assertRepositoryUrl(repository);
  const tag = deriveBetaTag(version);
  if (!noRegistry && (await versionExistsOnRegistry(version))) {
    assertVersionNotPublished(version, true);
  }
  const where = repository ? ` repo=${repository}` : '';
  console.log(`release guard OK: version=${version} tag=${tag}${where}`);
  return { version, tag };
}

const isMain =
  process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href;
if (isMain) {
  main(process.argv.slice(2)).catch((e) => {
    console.error(`release guard FAILED: ${e.message}`);
    process.exit(1);
  });
}
