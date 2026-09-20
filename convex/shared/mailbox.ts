/**
 * F1 single-mailbox validation and normalization (controlled contract, S-22).
 *
 * Validation runs through the maintained `validator` library
 * (validator@13.15.35, MIT) on its dependency-free ES path, which the
 * coordinator audit confirmed free of Buffer, node imports, and require
 * for the default browser-like Convex runtime. Normalization preserves
 * the local part exactly and lowercases only the domain: no dot/plus
 * folding, so distinct local parts stay distinct.
 *
 * This module registers no Convex functions.
 */

import isEmail from "validator/es/lib/isEmail.js";

/**
 * Normalize a mailbox for exact comparison: trim, preserve the local
 * part byte-for-byte, lowercase only the domain.
 */
export function normalizeMailbox(mailbox: string): string {
  const trimmed = mailbox.trim();
  const separator = trimmed.lastIndexOf("@");
  if (separator <= 0) return trimmed;
  const local = trimmed.slice(0, separator);
  const domain = trimmed.slice(separator + 1).toLowerCase();
  return `${local}@${domain}`;
}

/**
 * Strict single-mailbox validation (F1-21). Exactly one address: display
 * names, quoted local parts, angle brackets, commas, semicolons, and
 * whitespace never pass, so "a@b.test,c@d.test" or "Name <a@b.test>"
 * can never validate as one recipient.
 */
export function isValidSingleMailbox(mailbox: string): boolean {
  if (mailbox.length === 0 || mailbox.length > 320) return false;
  if (/[\s,;<>"]/.test(mailbox)) return false;
  return isEmail(mailbox, {
    allow_display_name: false,
    require_display_name: false,
    allow_utf8_local_part: false,
    require_tld: true,
    ignore_max_length: false,
  });
}
