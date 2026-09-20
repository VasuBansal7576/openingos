/**
 * F1 controlled counterparty provenance (controlled contract, ADR-0003).
 *
 * The owner plays the supplier through real email; live transport never turns
 * owner-authored terms into a real vendor quote. Every quote, answer, and
 * export inherits these labels so controlled demo evidence cannot masquerade
 * as a genuine vendor offer or realized savings.
 */

export const COUNTERPARTY_OWNER_STAND_IN = "ownerStandIn" as const;
export const COMMUNICATION_PROFILE_OWNER_ROLEPLAY = "ownerRoleplay" as const;

export type ExecutionMode = "live" | "recorded" | "fixture";
export type CounterpartyRole = typeof COUNTERPARTY_OWNER_STAND_IN | "vendor";

export interface Provenance {
  readonly counterpartyRole: CounterpartyRole;
  readonly executionMode: ExecutionMode;
}

/** Display label for transport + counterparty, safe for public guests. */
export function provenanceLabel(provenance: Provenance): string {
  if (provenance.counterpartyRole === COUNTERPARTY_OWNER_STAND_IN) {
    if (provenance.executionMode === "live") return "Live email · Demo supplier";
    if (provenance.executionMode === "recorded") return "Recorded demo exchange";
    return "Controlled demo quote";
  }
  if (provenance.executionMode === "live") return "Live vendor record";
  if (provenance.executionMode === "recorded") return "Recorded vendor record";
  return "Controlled fixture";
}

/** Owner-authored terms must always carry the stand-in role. */
export function ownerProvenance(executionMode: ExecutionMode): Provenance {
  return Object.freeze({
    counterpartyRole: COUNTERPARTY_OWNER_STAND_IN,
    executionMode,
  });
}

/**
 * Guard: owner-authored terms cannot overwrite researched vendor facts.
 * Returns true when the write target is allowed to accept owner terms
 * (a conversation-scoped quote), false for vendor-fact records.
 */
export function mayApplyOwnerTerms(target: "conversationQuote" | "vendorFacts" | "supplierPerformance"): boolean {
  return target === "conversationQuote";
}
