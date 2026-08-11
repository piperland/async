// Shared AbortSignal behavior for Piper primitives.
// Composes a local controller signal with an optional parent signal, preserving
// the first abort reason. No custom cancellation system.

/**
 * Compose a local controller with an optional parent signal.
 *
 * Returns the local controller and the effective signal to hand to work.
 * The effective signal aborts when either the local controller or the parent
 * aborts; its `reason` is whichever aborted first (via `AbortSignal.any`).
 */
export function composeSignal(parent: AbortSignal | undefined): {
  controller: AbortController;
  signal: AbortSignal;
} {
  const controller = new AbortController();
  const signal = parent
    ? AbortSignal.any([controller.signal, parent])
    : controller.signal;
  return { controller, signal };
}

/**
 * Abort the controller with the given reason if the effective signal is not
 * already aborted. If it is already aborted (e.g. the parent aborted first),
 * the existing reason wins — we never override an earlier terminal cause.
 */
export function requestCancellation(
  controller: AbortController,
  signal: AbortSignal,
  reason: unknown,
): void {
  if (!signal.aborted) {
    controller.abort(reason);
  }
}
