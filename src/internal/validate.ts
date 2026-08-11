// Shared numeric validation for Piper primitives.
// Small, explicit, no over-generalization. No dependency.

/** Validate a positive integer >= 1 (attempts, concurrency). */
export function assertPositiveInteger(value: number, name: string): void {
  if (!Number.isInteger(value) || value < 1) {
    throw new RangeError(
      `${name} must be a positive integer (>= 1), got ${String(value)}`,
    );
  }
}

/** Validate a finite, non-negative number (durations, delays in ms). */
export function assertFiniteNonNegative(value: number, name: string): void {
  if (typeof value !== 'number' || !Number.isFinite(value) || value < 0) {
    throw new RangeError(
      `${name} must be a finite non-negative number, got ${String(value)}`,
    );
  }
}
