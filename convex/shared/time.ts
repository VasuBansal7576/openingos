/**
 * F1 shared time/deadline semantics (controlled contract).
 *
 * Expiry is inclusive: at exactly `expiresAt`, authority has ended. A claim
 * with `nowMs >= expiresAt` is denied as expired. This exact-boundary rule is
 * pinned by tests so R1/C1/U1 share one interpretation of grant, job, and
 * recipient-version deadlines.
 */

/** True when `nowMs` has reached or passed the deadline. */
export function isExpired(nowMs: number, expiresAt: number): boolean {
  return nowMs >= expiresAt;
}

/** Milliseconds remaining before expiry; zero when already expired. */
export function millisRemaining(nowMs: number, expiresAt: number): number {
  return Math.max(0, expiresAt - nowMs);
}

/** Require a finite non-negative timestamp. */
export function assertTimestamp(value: unknown, label: string): number {
  if (typeof value !== "number" || !Number.isFinite(value) || value < 0) {
    throw new Error(`${label} must be a finite non-negative timestamp`);
  }
  return value;
}
