/**
 * F1 typed denials (controlled contract).
 *
 * Every authority failure produces a typed denial with zero new effect:
 * no job, operation, send, reservation, or record is created. Callers must
 * branch on `code`, never on message text.
 */

export const DENIAL_CODES = [
  "unknown-operation",
  "denied-capability",
  "unavailable-capability",
  "unrelated-refusal",
  "prompt-injection-denied",
  "forged-identity",
  "denied-membership",
  "denied-project",
  "expired-membership",
  "revoked-membership",
  "expired-grant",
  "revoked-grant",
  "stale-grant-version",
  "stale-input-version",
  "stale-recipient-version",
  "missing-recipient-config",
  "recipient-mismatch",
  "cc-not-empty",
  "bcc-not-empty",
  "reply-to-redirect",
  "alternate-channel-denied",
  "vendor-write-blocked",
  "changed-draft",
  "relevant-reply-superseded",
  "cancelled-before-claim",
  "duplicate-conflict",
  "allowance-exhausted",
  "unknown-charges-reserved",
  "already-claimed",
  "invalid-payload",
  "stale-catalog",
  "grant-expired-at-claim",
] as const;

export type DenialCode = (typeof DENIAL_CODES)[number];

export interface Denial {
  readonly ok: false;
  readonly code: DenialCode;
  readonly message: string;
}

export function denial(code: DenialCode, message: string): Denial {
  return Object.freeze({ ok: false, code, message });
}

export type Approved<T> = { readonly ok: true; readonly value: T };
export type AuthorityResult<T> = Approved<T> | Denial;

export function approved<T>(value: T): Approved<T> {
  return Object.freeze({ ok: true, value });
}
