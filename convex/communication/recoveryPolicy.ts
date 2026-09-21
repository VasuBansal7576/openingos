/**
 * Server-configured pricing for oversized-reply reconciliation reads.
 *
 * The per-read maximum comes from the owner's backend configuration; the
 * reservation basis is the canonical integrated string built by
 * `reconciliationPricingBasis`, so reads are admitted under exactly the
 * `agentmail-reconciliation-read-v1` contract the execution module
 * enforces. Absent or invalid pricing denies admission before any provider
 * read. This boundary never infers or invents a provider charge.
 */

import { env } from "../_generated/server.js";
import { reconciliationPricingBasis } from "./contracts.js";

export const RECOVERY_READ_MAX_COST_ENV_VAR =
  "AGENTMAIL_RECONCILIATION_READ_MAX_COST_MICRO_USD" as const;

export interface RecoveryReadPricing {
  readonly readCostMicroUsd: number;
  readonly basis: string;
}

export type RecoveryReadPricingResult =
  | { readonly ok: true; readonly pricing: RecoveryReadPricing }
  | { readonly ok: false; readonly code: "invalid-pricing-config"; readonly message: string };

/** Load the owner-configured per-read maximum at the server boundary. */
export function loadRecoveryReadPricing(): RecoveryReadPricingResult {
  const raw = env[RECOVERY_READ_MAX_COST_ENV_VAR]?.trim();
  if (raw === undefined || raw.length === 0 || !/^[0-9]+$/.test(raw)) {
    return {
      ok: false as const,
      code: "invalid-pricing-config",
      message: "reconciliation read pricing is not configured",
    };
  }
  const readCostMicroUsd = Number(raw);
  if (!Number.isSafeInteger(readCostMicroUsd) || readCostMicroUsd <= 0) {
    return {
      ok: false as const,
      code: "invalid-pricing-config",
      message: "reconciliation read pricing is invalid",
    };
  }
  return {
    ok: true as const,
    pricing: { readCostMicroUsd, basis: reconciliationPricingBasis(readCostMicroUsd) },
  };
}
