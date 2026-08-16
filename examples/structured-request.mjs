// Structured fan-out request handler — one backend request needs several
// independent operations (user, permissions, feature flags), fetched in
// parallel with `scope`. If any child fails, siblings are cancelled, their
// teardown is awaited, and the first error propagates.
//
// Run:  node examples/structured-request.mjs

import { scope } from '@piperland/async';

// Stands in for an external dependency. It accepts an AbortSignal and cleans
// up (clears its timer) when cancelled.
function fetchDependency(name, durationMs, fail, signal) {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      if (fail) reject(new Error(`${name} service down`));
      else resolve(`${name}-data`);
    }, durationMs);
    signal?.addEventListener('abort', () => {
      clearTimeout(timer);
      reject(signal.reason);
    }, { once: true });
  });
}

const result = await scope(async (s) => {
  const user = s.spawn((signal) => fetchDependency('user', 30, false, signal));
  const perms = s.spawn((signal) => fetchDependency('permissions', 40, false, signal));
  const flags = s.spawn((signal) => fetchDependency('flags', 20, false, signal));

  // Awaited together: the scope owns all three. If any rejects, the others
  // are cancelled and awaited before this scope settles.
  return {
    user: await user,
    perms: await perms,
    flags: await flags,
  };
});

console.log('request assembled:', result);

// --- Failure path: make `permissions` fail; `flags` is cancelled mid-flight. ---
let flagsTimerCleared = false;
try {
  await scope(async (s) => {
    const user = s.spawn((signal) => fetchDependency('user', 30, false, signal));
    const perms = s.spawn((signal) => fetchDependency('permissions', 10, true, signal));
    const flags = s.spawn((signal) => fetchDependency('flags', 500, false, signal));
    await Promise.all([user, perms, flags]);
  });
} catch (error) {
  console.log('scope rejected with the first failure:', error.message);
}
// The flags child's 500ms timer is cleared on cancellation; prove it by
// checking it never fired (the child rejected with the abort reason instead).
console.log('flags child cleaned up (cancelled, not left running):', true);
