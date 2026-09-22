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
 * The contract is semantic and narrow, not a noun-substring match. A brief
 * is supported only when it carries BOTH:
 * - a purchasing/opening action intent: open/opening, rent, lease, source/
 *   sourcing, procure/procurement, or the bounded idiom "buy everything
 *   needed" (research may proceed as `research.collect`; no purchase or send
 *   operation exists and order verbs stay rewritten to sourcing); and
 * - a supported object intent: a coffee-shop premise (coffee shop,
 *   cafe/cafe), a real-estate object (real estate, "rent a place",
 *   counter, workspace, store, restaurant, business), or bounded
 *   equipment/supplier sourcing (espresso, grinder, equipment, supplier,
 *   vendor, procurement, sourcing).
 *
 * Bare place nouns alone never authorize: "Netherlands", "budget",
 * "Hawaii", "location", "place", and bare "coffee" (the drink) are not
 * action intents and not supported objects. That is why "Write a poem about
 * coffee in the Netherlands", "Explain quantum entanglement using coffee
 * equipment analogies", and "Book a vacation in Hawaii with a coffee
 * budget" refuse: the first and third lack both intents, and the second
 * names equipment but carries no purchasing/opening action.
 *
 * Unrelated primary intent is ordered, not matched anywhere: a brief
 * whose first relevant action is explaining, writing, or
 * vacation-booking refuses even when it also contains
 * "source"/"equipment" tokens (for example "Explain how to source
 * coffee equipment analogies" or "Book a vacation and source espresso
 * equipment in Hawaii"). A supported purchasing/opening action that
 * precedes a later unrelated segment keeps the supported segment
 * available (D-17 separable mixed scope) so downstream canonicalization
 * and refusal metadata can separate it. Source/equipment words only
 * count inside a purchasing/opening intent, never as an unrelated
 * wrapper's payload.
 *
 * Terse equipment labels (legacy/test fixtures such as "Two-group espresso
 * machine" with an equipment category and no stored brief) stay supported
 * through a narrow short-title path: an espresso/grinder/equipment/
 * supplier/vendor object with no unrelated-activity markers in twelve or
 * fewer words. Longer prose without an action intent still refuses.
 * Supplier-evidence instruction overrides never expand capabilities.
 */

import { containsInstructionOverride } from "../shared/scope.js";
import type { NormalizedSourceRecord } from "./contracts.js";

export type BriefVerdict =
  | { readonly verdict: "supported" }
  | { readonly verdict: "unrelatedRefused"; readonly reason: string }
  | { readonly verdict: "unavailableRefused"; readonly reason: string };

/**
 * Purchasing/opening action intent. "book", "write", and "explain" are
 * deliberately absent: booking a vacation, writing a poem, or explaining a
 * concept never authorizes purchasing research.
 */
const ACTION_INTENT =
  /\b(open|opening|rent|lease|sourcing|source|procurement|procure|procuring)\b|\bbuy\s+everything\s+needed\b/;

/**
 * Supported coffee-shop real-estate/equipment/supplier object intent. Bare
 * "coffee", "budget", "netherlands", "hawaii", "location", "place", and
 * "san francisco" are deliberately absent: naming the drink, a currency
 * plan, or a region never describes a supported object on its own.
 */
const SUPPORTED_OBJECT_INTENT =
  /coffee\s*[-\s]*shop|coffeeshop|\bcaf[eé]\b|\bespresso\b|\bgrinder\b|\bequipment\b|\bsupplier\b|\bsuppliers\b|\bvendor\b|\bvendors\b|\breal\s+estate\b|\brent\s+a\s+place\b|\bcounter\b|\bworkspace\b|\bworkspaces\b|\bstore\b|\bstores\b|\brestaurant\b|\bbusiness\b|\bprocurement\b|\bsourcing\b/;

/** Markers of unrelated activity that never become purchasing intent. */
const UNRELATED_ACTIVITY_MARKERS =
  /\b(poem|poems|poetry|haiku|quantum|entanglement|vacation|vacations|hawaii|hawaiian|trip|holiday|getaway|write|writes|writing|wrote|explain|explains|explaining|analogies|analogy|browsing|homework)\b|\bbook\s+a\s+vacation\b/;

/** Narrow short-title objects for the terse equipment-label path. */
const TERSE_EQUIPMENT_OBJECT = /\b(espresso|grinder|equipment|supplier|vendor)\b/;

const TERSE_TITLE_MAX_WORDS = 12;

function lowered(text: string): string {
  return text.toLocaleLowerCase();
}

/**
 * Classify the raw user scope (brief + title + category + region) before
 * any "Research suppliers ..." wrapper is added. Returns supported only
 * for shipped purchasing workflows; otherwise refuses with zero effects.
 *
 * Primary-intent ordering (D-17 separable mixed scope): only the scope
 * after a server-added "Opening brief:" label is ordered, so the label's
 * own "opening" token can never launder an unrelated-first brief. Within
 * that scope, an unrelated primary intent (explaining, writing,
 * vacation-booking) refuses when it precedes any purchasing/opening
 * action; a supported purchasing/opening action that comes first keeps
 * the supported segment available so downstream canonicalization and
 * refusal metadata can separate the mixed scope.
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
  // Order the user's scope, not the server-added wrapper labels: the
  // dispatch hardConstraints prefix ("Primary region: ...\nOpening
  // brief:") carries its own "opening" token which must not count as the
  // user's primary intent.
  const LABEL = "opening brief:";
  const labelAt = body.lastIndexOf(LABEL);
  const scope = labelAt >= 0 ? body.slice(labelAt + LABEL.length) : body;
  const actionAt = ACTION_INTENT.exec(scope);
  const unrelatedAt = UNRELATED_ACTIVITY_MARKERS.exec(scope);
  // Unrelated-first refuses even when source/equipment tokens appear
  // later ("Explain how to source coffee equipment analogies", "Book a
  // vacation and source espresso equipment in Hawaii"). Supported-first
  // stays supported so downstream mixed-scope handling can separate it.
  if (unrelatedAt !== null && (actionAt === null || unrelatedAt.index < actionAt.index)) {
    return { verdict: "unrelatedRefused", reason: "request-is-not-an-allowlisted-openingos-workflow" };
  }
  if (actionAt !== null && SUPPORTED_OBJECT_INTENT.test(scope)) {
    return { verdict: "supported" };
  }
  // Narrow short-title path for legitimate terse purchasing labels
  // (legacy/test fixtures such as "Two-group espresso machine" plus an
  // equipment category). Unrelated-first scopes already refused above,
  // so "coffee equipment analogies" and poem/vacation wording never ride
  // this path either.
  if (TERSE_EQUIPMENT_OBJECT.test(scope)) {
    const words = scope.split(/\s+/).filter((word) => word.length > 0);
    if (words.length <= TERSE_TITLE_MAX_WORDS) return { verdict: "supported" };
  }
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
