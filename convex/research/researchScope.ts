/**
 * Opening-brief scope gate for research authority (Astra repair, D-17).
 *
 * The classifier answers one question before any supplier search wording is
 * added: does the user's actual opening brief/scope describe a shipped
 * OpeningOS purchasing workflow? Supported work is the coffee-shop opening,
 * real-estate/rent research, and bounded equipment sourcing. Everything else
 * — homework, vacations, general browsing — refuses before any grant, job,
 * reservation, operation, schedule, or provider effect.
 *
 * Rules are deliberately positive and narrow:
 * - supported needs a business anchor (coffee/cafe/shop/equipment/supplier/
 *   vendor/procurement/sourcing) together with a project anchor (open/
 *   opening/rent/lease/real estate/budget/equipment/supplier). The coffee
 *   brief "Open a coffee shop in San Francisco; rent a place and buy
 *   everything needed; budget USD ..." carries both.
 * - "buy everything needed" inside a supported opening is bounded sourcing,
 *   not a purchase execution: research may proceed as `research.collect`,
 *   but no purchase/send operation exists and the dispatch query rewrites
 *   order verbs to the collection verb "source".
 * - unrelated briefs such as "Explain quantum entanglement" or "Book a
 *   vacation in Hawaii" carry neither anchor set and refuse.
 * - supplier-evidence instruction overrides never expand capabilities.
 */

import { containsInstructionOverride } from "../shared/scope.js";
import type { NormalizedSourceRecord } from "./contracts.js";

export type BriefVerdict =
  | { readonly verdict: "supported" }
  | { readonly verdict: "unrelatedRefused"; readonly reason: string }
  | { readonly verdict: "unavailableRefused"; readonly reason: string };

const BUSINESS_ANCHORS = [
  "coffee",
  "cafe",
  "café",
  "coffee shop",
  "coffee-shop",
  "coffeeshop",
  "shop opening",
  // Generic opening nouns used by supported intake briefs ("open a second
  // counter", "another tenant workspace", "guest counter"). These ride with
  // a project anchor (open/rent/place) and never match homework or vacation
  // wording on their own.
  "counter",
  "workspace",
  "workspaces",
  "store",
  "stores",
  "business",
  "restaurant",
  "equipment",
  "supplier",
  "suppliers",
  "vendor",
  "vendors",
  "procurement",
  "procure",
  "sourcing",
  "espresso",
  "grinder",
  "refrigerat",
] as const;

const PROJECT_ANCHORS = [
  "open",
  "opening",
  "rent",
  "lease",
  "real estate",
  "budget",
  "equipment",
  "supplier",
  "suppliers",
  "vendor",
  "vendors",
  "sourcing",
  "procurement",
  "san francisco",
  "netherlands",
  "location",
  "place",
] as const;

function lowered(text: string): string {
  return text.toLocaleLowerCase();
}

function hasAny(haystack: string, needles: readonly string[]): boolean {
  return needles.some((needle) => haystack.includes(needle));
}

/**
 * Classify the raw user scope (brief + title + category + region) before
 * any "Research suppliers ..." wrapper is added. Returns supported only
 * for shipped purchasing workflows; otherwise refuses with zero effects.
 */
export function classifyOpeningBriefForResearch(text: string): BriefVerdict {
  const body = lowered(text);
  if (body.trim().length === 0) {
    return { verdict: "unrelatedRefused", reason: "request-is-not-an-allowlisted-openingos-workflow" };
  }
  if (containsInstructionOverride(text)) {
    return {
      verdict: "unrelatedRefused",
      reason: "supplier-evidence-instructions-cannot-expand-capabilities",
    };
  }
  const business = hasAny(body, BUSINESS_ANCHORS);
  const project = hasAny(body, PROJECT_ANCHORS);
  if (business && project) return { verdict: "supported" };
  return { verdict: "unrelatedRefused", reason: "request-is-not-an-allowlisted-openingos-workflow" };
}

/**
 * Supported supplier/product evidence gate (Astra repair).
 *
 * Arbitrary titled URLs (discussion threads, civic pages, informational
 * articles) are stored as research source records but never promoted into
 * vendor/product candidates or quote evidence. Promotion requires an
 * explicit product model, an explicit vendor, and at least one commercial
 * price claim from the normalized provider record.
 */
export function hasSupportedSupplierEvidence(record: NormalizedSourceRecord): boolean {
  if (record.productModel === undefined || record.productModel.trim().length === 0) return false;
  if (record.vendorName === undefined || record.vendorName.trim().length === 0) return false;
  return record.claims.some(
    (claim) => claim.field === "price" && claim.normalizedValue.trim().length > 0,
  );
}
