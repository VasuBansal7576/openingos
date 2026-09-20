/**
 * F1 immutable quote versions and equivalent-scope comparison
 * (controlled contract, ADR-0003).
 *
 * Quote versions are immutable: revisions create new versions that
 * supersede, never overwrite. Money is integer minor units; unknown
 * charges carry no amount and block any "cheaper" claim. Owner-authored
 * terms keep `counterpartyRole: ownerStandIn` and never overwrite
 * researched vendor facts.
 *
 * Visibility: `record` is a public user import (corrections and manual
 * quotes under project capability); `ingestProviderQuote` is the
 * internal provider write for the extraction pipeline. Both share one
 * money/provenance validation core.
 */

import { v } from "convex/values";
import type { Id } from "../../_generated/dataModel.js";
import { f1InternalMutation, f1Mutation, f1Query, type F1MutationCtx } from "../../server.js";
import { payloadHash } from "../../shared/hashing.js";
import { compareEquivalentScope } from "../../shared/compare.js";
import { checkMoney } from "../../shared/money.js";
import { approved, denial, type AuthorityResult } from "../../shared/denials.js";
import { checkProjectAccess, denialValidator, identityOf, requireCapability } from "../../access/checks.js";

const moneyInputValidator = v.object({ currency: v.string(), minorUnits: v.number() });

const lineValidator = v.object({
  lineId: v.string(),
  description: v.string(),
  quantity: v.string(),
  unitPrice: moneyInputValidator,
  evidenceRefs: v.array(v.object({ sourceId: v.string(), version: v.string(), locator: v.string() })),
});

const chargeValidator = v.object({
  chargeId: v.string(),
  label: v.string(),
  state: v.string(),
  amount: v.optional(moneyInputValidator),
});

/**
 * Public user-import fields. Provenance is NOT caller-supplied: the
 * handler derives `counterpartyRole: userImport` and `executionMode:
 * recorded` server-side. Passing live/vendor assertions is a validator
 * rejection, not a silent override.
 */
const userQuoteFieldsValidator = v.object({
  organizationId: v.id("organizations"),
  projectId: v.id("projects"),
  version: v.string(),
  currency: v.string(),
  lines: v.array(lineValidator),
  charges: v.array(chargeValidator),
  taxBasis: v.string(),
  evidenceRefs: v.array(v.object({ sourceId: v.string(), version: v.string(), locator: v.string() })),
  conversationId: v.optional(v.id("conversations")),
  supersedes: v.optional(v.string()),
});

/** Provider-ingest fields: provenance travels with the verified pipeline. */
const providerQuoteFieldsValidator = v.object({
  organizationId: v.id("organizations"),
  projectId: v.id("projects"),
  version: v.string(),
  currency: v.string(),
  lines: v.array(lineValidator),
  charges: v.array(chargeValidator),
  taxBasis: v.string(),
  evidenceRefs: v.array(v.object({ sourceId: v.string(), version: v.string(), locator: v.string() })),
  counterpartyRole: v.union(v.literal("vendor"), v.literal("ownerStandIn")),
  executionMode: v.union(v.literal("live"), v.literal("recorded")),
  conversationId: v.optional(v.id("conversations")),
  supersedes: v.optional(v.string()),
});

type QuoteFields = {
  organizationId: Id<"organizations">;
  projectId: Id<"projects">;
  version: string;
  currency: string;
  lines: {
    lineId: string;
    description: string;
    quantity: string;
    unitPrice: { currency: string; minorUnits: number };
    evidenceRefs: { sourceId: string; version: string; locator: string }[];
  }[];
  charges: {
    chargeId: string;
    label: string;
    state: string;
    amount?: { currency: string; minorUnits: number };
  }[];
  taxBasis: string;
  evidenceRefs: { sourceId: string; version: string; locator: string }[];
  counterpartyRole: string;
  executionMode: "live" | "recorded" | "fixture";
  conversationId?: Id<"conversations">;
  supersedes?: string;
};

function validateQuoteFields(fields: QuoteFields): AuthorityResult<QuoteFields> {
  if (!/^[A-Z]{3}$/.test(fields.currency)) {
    return denial("invalid-payload", "currency must be ISO 4217");
  }
  for (const line of fields.lines) {
    try {
      checkMoney(line.unitPrice, `line ${line.lineId}`);
    } catch {
      return denial("invalid-payload", `line ${line.lineId} is not valid minor-unit money`);
    }
    if (line.unitPrice.currency !== fields.currency) {
      return denial("invalid-payload", `line ${line.lineId} mixes currency`);
    }
  }
  for (const charge of fields.charges) {
    if (charge.amount !== undefined) {
      try {
        checkMoney(charge.amount, `charge ${charge.chargeId}`);
      } catch {
        return denial("invalid-payload", `charge ${charge.chargeId} is not valid minor-unit money`);
      }
    }
    if (charge.state === "unknown" && charge.amount !== undefined) {
      return denial("invalid-payload", `unknown charge ${charge.chargeId} must not carry an amount`);
    }
  }
  return approved(fields);
}

/**
 * Immutable version, supersedes, and conversation references. Versions are
 * never overwritten; a revision must name the exact content hash it
 * replaces, and conversations must live in the same project.
 */
async function checkQuoteReferences(
  ctx: F1MutationCtx,
  organizationId: Id<"organizations">,
  projectId: Id<"projects">,
  fields: Pick<QuoteFields, "version" | "conversationId" | "supersedes">,
): Promise<AuthorityResult<true>> {
  if (fields.version.trim().length === 0) {
    return denial("invalid-payload", "version required");
  }
  if (fields.conversationId !== undefined) {
    const conversation = await ctx.db.get(fields.conversationId);
    if (
      conversation === null ||
      conversation.organizationId !== organizationId ||
      conversation.projectId !== projectId
    ) {
      return denial("denied-project", "conversation is not in this project");
    }
  }
  if (fields.supersedes !== undefined) {
    const prior = await ctx.db
      .query("quotes")
      .withIndex("by_contentHash", (q) => q.eq("contentHash", fields.supersedes ?? ""))
      .unique();
    if (
      prior === null ||
      prior.organizationId !== organizationId ||
      prior.projectId !== projectId
    ) {
      return denial("invalid-payload", "supersedes unknown quote version");
    }
  }
  return approved(true);
}

async function insertQuoteVersion(
  ctx: F1MutationCtx,
  fields: QuoteFields,
  now: number,
): Promise<{ quoteId: Id<"quotes">; contentHash: string }> {
  const contentHash = payloadHash({
    version: fields.version,
    currency: fields.currency,
    lines: fields.lines,
    charges: fields.charges,
    taxBasis: fields.taxBasis,
  });
  const quoteId = await ctx.db.insert("quotes", {
    organizationId: fields.organizationId,
    projectId: fields.projectId,
    ...(fields.conversationId === undefined ? {} : { conversationId: fields.conversationId }),
    version: fields.version,
    contentHash,
    currency: fields.currency,
    lines: fields.lines.map((line) => ({ ...line, evidenceRefs: [...line.evidenceRefs] })),
    charges: fields.charges.map((charge) => ({ ...charge })),
    taxBasis: fields.taxBasis,
    evidenceRefs: [...fields.evidenceRefs],
    counterpartyRole: fields.counterpartyRole,
    executionMode: fields.executionMode,
    ...(fields.supersedes === undefined ? {} : { supersedes: fields.supersedes }),
    createdAt: now,
  });
  return { quoteId, contentHash };
}

const recordResultValidator = v.union(
  v.object({ ok: v.literal(true), quoteId: v.id("quotes"), contentHash: v.string() }),
  denialValidator,
);

/** Public user import: record an immutable quote version with capability. */
export const record = f1Mutation({
  args: userQuoteFieldsValidator,
  returns: recordResultValidator,
  handler: async (ctx, args) => {
    const identity = await identityOf(ctx);
    if (identity === null) {
      return { ok: false as const, code: "forged-identity", message: "unauthenticated" };
    }
    const now = Date.now();
    const access = await checkProjectAccess(
      ctx,
      identity,
      args.organizationId,
      args.projectId,
      "contributor",
      now,
    );
    if (!access.ok) return { ok: false as const, code: access.code, message: access.message };
    const capability = requireCapability("quote.record", access.value);
    if (!capability.ok) {
      return { ok: false as const, code: capability.code, message: capability.message };
    }
    const valid = validateQuoteFields({
      ...args,
      counterpartyRole: "userImport",
      executionMode: "recorded",
    });
    if (!valid.ok) return { ok: false as const, code: valid.code, message: valid.message };
    const references = await checkQuoteReferences(ctx, args.organizationId, args.projectId, args);
    if (!references.ok) {
      return { ok: false as const, code: references.code, message: references.message };
    }
    const { quoteId, contentHash } = await insertQuoteVersion(ctx, valid.value, now);
    return { ok: true as const, quoteId, contentHash };
  },
});

/**
 * Internal provider write: extraction pipeline only, same money rules.
 * Fixture execution mode is unavailable here and in public runtime.
 */
export const ingestProviderQuote = f1InternalMutation({
  args: providerQuoteFieldsValidator,
  returns: recordResultValidator,
  handler: async (ctx, args) => {
    const project = await ctx.db.get(args.projectId);
    if (project === null || project.organizationId !== args.organizationId) {
      return { ok: false as const, code: "denied-membership", message: "not authorized for this project" };
    }
    const valid = validateQuoteFields(args);
    if (!valid.ok) return { ok: false as const, code: valid.code, message: valid.message };
    const references = await checkQuoteReferences(ctx, args.organizationId, args.projectId, args);
    if (!references.ok) {
      return { ok: false as const, code: references.code, message: references.message };
    }
    const { quoteId, contentHash } = await insertQuoteVersion(ctx, valid.value, Date.now());
    return { ok: true as const, quoteId, contentHash };
  },
});

const compareResultValidator = v.union(
  v.object({
    ok: v.literal(true),
    verdict: v.string(),
    differenceMinorUnits: v.union(v.number(), v.null()),
    cheaper: v.union(v.string(), v.null()),
    reason: v.string(),
  }),
  denialValidator,
);

/** Equivalent-scope comparison; unknown charges block complete claims. */
export const compare = f1Query({
  args: {
    leftQuoteId: v.id("quotes"),
    rightQuoteId: v.id("quotes"),
  },
  returns: compareResultValidator,
  handler: async (ctx, args) => {
    const identity = await identityOf(ctx);
    if (identity === null) {
      return { ok: false as const, code: "forged-identity", message: "unauthenticated" };
    }
    const left = await ctx.db.get(args.leftQuoteId);
    if (left === null) {
      return { ok: false as const, code: "denied-membership", message: "not authorized for this project" };
    }
    const access = await checkProjectAccess(
      ctx,
      identity,
      left.organizationId,
      left.projectId,
      "viewer",
      Date.now(),
    );
    if (!access.ok) return { ok: false as const, code: access.code, message: access.message };
    const right = await ctx.db.get(args.rightQuoteId);
    if (
      right === null ||
      right.organizationId !== left.organizationId ||
      right.projectId !== left.projectId
    ) {
      return { ok: false as const, code: "denied-project", message: "quotes are not in this project" };
    }
    const toComparable = (quote: typeof left) => ({
      currency: quote.currency,
      taxBasis: quote.taxBasis,
      lines: quote.lines.map((line) => ({
        quantity: line.quantity,
        unitPriceMinorUnits: line.unitPrice.minorUnits,
      })),
      charges: quote.charges.map((charge) => ({
        state: charge.state,
        ...(charge.amount === undefined ? {} : { amountMinorUnits: charge.amount.minorUnits }),
      })),
    });
    const verdict = compareEquivalentScope(toComparable(left), toComparable(right));
    return {
      ok: true as const,
      verdict: verdict.verdict,
      differenceMinorUnits: verdict.differenceMinorUnits,
      cheaper: verdict.cheaper,
      reason: verdict.reason,
    };
  },
});
