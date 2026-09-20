// Closed operation catalog for hackathon supplier browsing.
//
// Only read-only navigation and variant inspection may execute. Vendor
// contact forms, chat messages, RFQ submissions, account creation, downloads
// with side effects, purchases, arbitrary selectors, and arbitrary scripts
// are denied — including when requested through a recovery or strategy
// change, which can only select another permitted read-only operation.
// Unknown operation IDs are denied; the catalog version is pinned per job.

import type { Decision, DenialReason, OperationEffect } from "./types.ts";
import { approved, denied } from "./types.ts";

export const OPERATION_CATALOG_VERSION = "browser-catalog-1";

export interface CatalogEntry {
  readonly operationId: string;
  readonly effect: OperationEffect;
  readonly permitted: boolean;
  readonly denialReason: DenialReason | undefined;
  readonly description: string;
}

const ENTRIES: readonly CatalogEntry[] = Object.freeze([
  Object.freeze({
    operationId: "navigate",
    effect: "read",
    permitted: true,
    denialReason: undefined,
    description: "Navigate to a policy-validated destination",
  }),
  Object.freeze({
    operationId: "readVisibleText",
    effect: "read",
    permitted: true,
    denialReason: undefined,
    description: "Read visible text of the current document",
  }),
  Object.freeze({
    operationId: "listTargets",
    effect: "read",
    permitted: true,
    denialReason: undefined,
    description: "List interactable targets of the current document",
  }),
  Object.freeze({
    operationId: "inspectTarget",
    effect: "read",
    permitted: true,
    denialReason: undefined,
    description: "Inspect one previously observed target",
  }),
  Object.freeze({
    operationId: "captureSnapshot",
    effect: "read",
    permitted: true,
    denialReason: undefined,
    description: "Capture a read-only snapshot of the current document",
  }),
  Object.freeze({
    operationId: "reobserve",
    effect: "read",
    permitted: true,
    denialReason: undefined,
    description: "Take a fresh observation after a stale document",
  }),
  Object.freeze({
    operationId: "submitContactForm",
    effect: "vendorWrite",
    permitted: false,
    denialReason: "vendor-write-blocked",
    description: "Vendor-facing contact form submission (disabled)",
  }),
  Object.freeze({
    operationId: "sendChatMessage",
    effect: "vendorWrite",
    permitted: false,
    denialReason: "vendor-write-blocked",
    description: "Vendor website chat message (disabled)",
  }),
  Object.freeze({
    operationId: "submitRfq",
    effect: "vendorWrite",
    permitted: false,
    denialReason: "vendor-write-blocked",
    description: "RFQ submission through a vendor page (disabled)",
  }),
  Object.freeze({
    operationId: "purchase",
    effect: "purchase",
    permitted: false,
    denialReason: "purchase-blocked",
    description: "Purchase or cart checkout (disabled)",
  }),
  Object.freeze({
    operationId: "createAccount",
    effect: "account",
    permitted: false,
    denialReason: "account-blocked",
    description: "Vendor account creation (disabled)",
  }),
  Object.freeze({
    operationId: "downloadFile",
    effect: "download",
    permitted: false,
    denialReason: "download-blocked",
    description: "File download with side effects (disabled)",
  }),
  Object.freeze({
    operationId: "runScript",
    effect: "script",
    permitted: false,
    denialReason: "script-blocked",
    description: "Arbitrary script execution (disabled)",
  }),
  Object.freeze({
    operationId: "selectArbitrary",
    effect: "script",
    permitted: false,
    denialReason: "arbitrary-selector-blocked",
    description: "Arbitrary selector input that bypasses observed targets (disabled)",
  }),
]);

const BY_ID: ReadonlyMap<string, CatalogEntry> = new Map(
  ENTRIES.map((entry) => [entry.operationId, entry] as const),
);

export function catalogEntries(): readonly CatalogEntry[] {
  return ENTRIES;
}

export function lookupOperation(operationId: string): CatalogEntry | undefined {
  return BY_ID.get(operationId);
}

/**
 * Authorize one catalogued operation. Recovery and strategy-change routes
 * call the same check, so a blocked vendor write cannot slip through a
 * retry under a different name.
 */
export function authorizeOperation(
  operationId: string,
  catalogVersion: string,
  viaRecovery: boolean,
): Decision {
  if (catalogVersion !== OPERATION_CATALOG_VERSION) {
    return denied("stale-catalog", `catalog "${catalogVersion}" does not match ${OPERATION_CATALOG_VERSION}`);
  }
  const entry = lookupOperation(operationId);
  if (entry === undefined) {
    return denied("unknown-operation", `operation "${operationId}" is not in the catalog`);
  }
  if (!entry.permitted) {
    const reason = entry.denialReason ?? "unknown-operation";
    const route = viaRecovery ? " (recovery route)" : "";
    return denied(reason, `operation "${operationId}" is disabled${route}`);
  }
  return approved();
}
