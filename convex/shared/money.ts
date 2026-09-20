/**
 * F1 shared money validators (controlled contract, ADR-0003).
 *
 * Integer minor units plus ISO currency; unknown charges stay unknown and
 * are never coerced to zero. Pure validation here reuses the accepted
 * proofs/money implementation so F1 cannot drift from the reviewed contract.
 */

import { v } from "convex/values";
import {
  currencyCode,
  money as makeMoney,
  normalizeMoney,
  type Money,
} from "../../proofs/money/money.js";

export type { Money };

export const moneyValidator = v.object({
  currency: v.string(),
  minorUnits: v.number(),
});

/** Validate one Money record; throws MoneyValidationError on violation. */
export function checkMoney(input: unknown, label = "money"): Money {
  return normalizeMoney(input, label);
}

/** Validate an ISO 4217 currency code. */
export function checkCurrency(input: unknown): string {
  return currencyCode(input);
}

/** Build Money from parts (validates integer minor units + ISO code). */
export function makeCheckedMoney(currency: unknown, minorUnits: unknown): Money {
  return makeMoney(currency, minorUnits);
}

/** Unknown charge marker: presence of this state forbids zero-substitution. */
export const UNKNOWN_CHARGE = "unknown" as const;

/** All charge states in the accepted contract. */
export const CHARGE_STATES = [
  "known",
  "included",
  "estimated",
  "unknown",
  "notApplicable",
] as const;

export type ChargeState = (typeof CHARGE_STATES)[number];

/** True when a charge state forbids treating the amount as zero/complete. */
export function chargeBlocksCompleteOffer(state: string): boolean {
  return state === UNKNOWN_CHARGE;
}
