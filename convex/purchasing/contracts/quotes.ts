/**
 * F1 immutable quote versions and exact-scope comparison
 * (controlled contract, ADR-0003).
 *
 * Quote versions are immutable: revisions create new versions that
 * supersede, never overwrite. Every document parses through the accepted
 * proofs/money/quote.ts constructors, so discriminated charge states
 * (known/included/estimated point-or-range/unknown/notApplicable with
 * required reasons or coveringIds), quote/line/allocated scopes with
 * evidence, exact comparison scopes, duplicate rejection, currency and
 * range validation, and dangling/cyclic coverage rejection all hold on
 * the real backend exactly as proven. Comparison runs through the
 * accepted proofs/money/comparison.ts engine over stable scope items, so
 * reorder is tolerated while unrelated aggregate-equal lines never
 * compare. Owner-authored terms keep `counterpartyRole: ownerStandIn`
 * and never overwrite researched vendor facts.
 *
 * Visibility: `record` is a public user import (corrections and manual
 * quotes under project capability); `ingestProviderQuote` is the
 * internal provider write for the extraction pipeline. Both share one
 * proofs-backed validation core.
 */

import { v } from "convex/values";
import type { Id } from "../../_generated/dataModel.js";
import { f1InternalMutation, f1Mutation, f1Query, type F1MutationCtx } from "../../server.js";
import { canonicalJson } from "../../shared/hashing.js";
import { sha256HexOfCanonical } from "../../shared/sha256.js";
import {
  compareStoredQuotes,
  parseQuoteDocument,
  quoteChargeInputValidator,
  quoteComparisonScopeValidator,
  quoteDecisionFields,
  quoteEvidenceRefValidator,
  quoteLineInputValidator,
  quoteTaxBasisValidator,
  storedQuoteParts,
} from "../../shared/quoteSemantics.js";
import type { Quote } from "../../shared/quoteSemantics.js";
import { approved, denial, type AuthorityResult } from "../../shared/denials.js";
import { checkProjectAccess, denialValidator, identityOf, requireCapability } from "../../access/checks.js";

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
  lines: v.array(quoteLineInputValidator),
  charges: v.optional(v.array(quoteChargeInputValidator)),
  taxBasis: quoteTaxBasisValidator,
  comparisonScope: v.optional(quoteComparisonScopeValidator),
  evidenceRefs: v.optional(v.array(quoteEvidenceRefValidator)),
  conversationId: v.optional(v.id("conversations")),
  requirementId: v.optional(v.id("requirements")),
  vendorId: v.optional(v.id("vendors")),
  rfqId: v.optional(v.id("rfqs")),
  supersedes: v.optional(v.string()),
});

/** Provider-ingest fields: provenance travels with the verified pipeline. */
const providerQuoteFieldsValidator = v.object({
  organizationId: v.id("organizations"),
  projectId: v.id("projects"),
  version: v.string(),
  currency: v.string(),
  lines: v.array(quoteLineInputValidator),
  charges: v.optional(v.array(quoteChargeInputValidator)),
  taxBasis: quoteTaxBasisValidator,
  comparisonScope: v.optional(quoteComparisonScopeValidator),
  evidenceRefs: v.optional(v.array(quoteEvidenceRefValidator)),
  counterpartyRole: v.union(v.literal("vendor"), v.literal("ownerStandIn")),
  executionMode: v.union(v.literal("live"), v.literal("recorded")),
  conversationId: v.optional(v.id("conversations")),
  requirementId: v.optional(v.id("requirements")),
  vendorId: v.optional(v.id("vendors")),
  rfqId: v.optional(v.id("rfqs")),
  supersedes: v.optional(v.string()),
});

type QuoteFields = {
  organizationId: Id<"organizations">;
  projectId: Id<"projects">;
  version: string;
  currency: string;
  lines: unknown[];
  charges?: unknown[];
  taxBasis: unknown;
  comparisonScope?: unknown;
  evidenceRefs?: unknown;
  counterpartyRole: string;
  executionMode: "live" | "recorded" | "fixture";
  conversationId?: Id<"conversations">;
  requirementId?: Id<"requirements">;
  vendorId?: Id<"vendors">;
  rfqId?: Id<"rfqs">;
  supersedes?: string;
  /** Server-derived from the requirement row at quote creation time. */
  requirementVersion?: number;
};

function validateQuoteFields(fields: QuoteFields): AuthorityResult<Quote> {
  try {
    return approved(
      parseQuoteDocument({
        quoteId: fields.version,
        version: fields.version,
        currency: fields.currency,
        lines: fields.lines,
        ...(fields.charges === undefined ? {} : { charges: fields.charges }),
        taxBasis: fields.taxBasis,
        ...(fields.comparisonScope === undefined ? {} : { comparisonScope: fields.comparisonScope }),
        ...(fields.evidenceRefs === undefined ? {} : { evidenceRefs: fields.evidenceRefs }),
      }),
    );
  } catch (error) {
    return denial("invalid-payload", error instanceof Error ? error.message : "quote is invalid");
  }
}

/**
 * Immutable version, supersedes lineage, and graph references.
 * Versions are never overwritten and are unique per project; a revision
 * must name the exact content hash it replaces, and the superseded
 * version must share the same project, conversation binding, and
 * counterparty lineage. Conversations, requirements, vendors, and RFQs
 * must live in the same project (F1 shared-domain graph).
 */
async function checkQuoteReferences(
  ctx: F1MutationCtx,
  organizationId: Id<"organizations">,
  projectId: Id<"projects">,
  fields: Pick<
    QuoteFields,
    | "version"
    | "conversationId"
    | "requirementId"
    | "vendorId"
    | "rfqId"
    | "comparisonScope"
    | "supersedes"
    | "counterpartyRole"
  >,
): Promise<AuthorityResult<{ readonly requirementVersion?: number }>> {
  let requirementVersion: number | undefined;
  let rfqRequirementId: Id<"requirements"> | undefined;
  if (fields.version.trim().length === 0) {
    return denial("invalid-payload", "version required");
  }
  // Bounded duplicate check: the compound index fetches at most the one
  // row carrying this version in this project, never the full history.
  const duplicate = await ctx.db
    .query("quotes")
    .withIndex("by_project_and_version", (q) =>
      q.eq("projectId", projectId).eq("version", fields.version),
    )
    .unique();
  if (duplicate !== null) {
    return denial("invalid-payload", `duplicate quote version ${fields.version}`);
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
  if (fields.requirementId !== undefined) {
    const requirement = await ctx.db.get(fields.requirementId);
    if (
      requirement === null ||
      requirement.organizationId !== organizationId ||
      requirement.projectId !== projectId
    ) {
      return denial("denied-project", "requirement is not in this project");
    }
    requirementVersion = requirement.version;
  }
  if (fields.vendorId !== undefined) {
    // Vendors are organization-scoped supplier identity: the binding
    // check is the organization, while project authorization to engage
    // the vendor travels through vendor contacts and RFQ recipients.
    const vendor = await ctx.db.get(fields.vendorId);
    if (vendor === null || vendor.organizationId !== organizationId) {
      return denial("denied-project", "vendor is not in this organization");
    }
  }
  if (fields.rfqId !== undefined) {
    const rfq = await ctx.db.get(fields.rfqId);
    if (
      rfq === null ||
      rfq.organizationId !== organizationId ||
      rfq.projectId !== projectId
    ) {
      return denial("denied-project", "rfq is not in this project");
    }
    rfqRequirementId = rfq.requirementId;
    if (fields.requirementId === undefined) {
      const requirement = await ctx.db.get(rfq.requirementId);
      if (
        requirement === null ||
        requirement.organizationId !== organizationId ||
        requirement.projectId !== projectId
      ) {
        return denial("denied-project", "rfq requirement is not in this project");
      }
      requirementVersion = requirement.version;
    }
  }
  // F1R-03: related references must agree with each other, not merely
  // resolve in-project. A quote cannot bind an RFQ scoped to another
  // requirement, a vendor outside the RFQ's scenario vendors, or a
  // comparison scope naming another requirement. Any permitted
  // multi-requirement mapping must be represented explicitly, never
  // inferred from independent fields.
  if (
    rfqRequirementId !== undefined &&
    fields.requirementId !== undefined &&
    rfqRequirementId !== fields.requirementId
  ) {
    return denial("denied-project", "quote RFQ is bound to another requirement");
  }
  if (fields.rfqId !== undefined && fields.vendorId !== undefined) {
    const rfq = await ctx.db.get(fields.rfqId);
    if (rfq !== null && !rfq.scenarioVendorIds.includes(fields.vendorId)) {
      return denial("denied-project", "quote vendor is outside the RFQ scenario vendors");
    }
  }
  // Note: comparisonScope.requirementId is an opaque commercial scope
  // label (existing records use values like "req-domain"), not a
  // requirement row reference, so it is never equated with
  // requirementId here. Scope-to-requirement agreement is enforced
  // through the requirement/RFQ/vendor bindings above.
  if (fields.supersedes !== undefined) {
    // Lineage resolves inside this project only: identical content in
    // another project carries a different hash and never links here.
    const prior = await ctx.db
      .query("quotes")
      .withIndex("by_project_and_contentHash", (q) =>
        q.eq("projectId", projectId).eq("contentHash", fields.supersedes ?? ""),
      )
      .unique();
    if (prior === null || prior.organizationId !== organizationId) {
      return denial("invalid-payload", "supersedes unknown quote version");
    }
    const sameConversation = (prior.conversationId ?? undefined) === fields.conversationId;
    if (!sameConversation) {
      return denial("invalid-payload", "supersedes must share the conversation binding");
    }
    if (prior.counterpartyRole !== fields.counterpartyRole) {
      return denial("invalid-payload", "supersedes must share the counterparty lineage");
    }
    // F1R-08: a successor must retain its offer's stable lineage — the
    // same requirement, vendor, and RFQ. A revision of one supplier's
    // offer can never silently adopt another offer's content hash, with
    // or without conversations. An RFQ or scope change that is genuinely
    // a new offer is recorded without a supersedes link, never by
    // crossing the lineage.
    if ((prior.requirementId ?? undefined) !== fields.requirementId) {
      return denial("invalid-payload", "supersedes must retain the offer requirement");
    }
    if ((prior.vendorId ?? undefined) !== fields.vendorId) {
      return denial("invalid-payload", "supersedes must retain the offer vendor");
    }
    if ((prior.rfqId ?? undefined) !== fields.rfqId) {
      return denial("invalid-payload", "supersedes must retain the offer RFQ");
    }
  }
  return approved(
    requirementVersion === undefined ? {} : { requirementVersion },
  );
}

async function insertQuoteVersion(
  ctx: F1MutationCtx,
  fields: QuoteFields,
  quote: Quote,
  now: number,
): Promise<{ quoteId: Id<"quotes">; contentHash: string }> {
  const parts = storedQuoteParts(quote);
  const decisionFields = quoteDecisionFields({
    organizationId: fields.organizationId,
    projectId: fields.projectId,
    version: quote.version,
    currency: parts.currency,
    lines: parts.lines,
    charges: parts.charges,
    taxBasis: parts.taxBasis,
    ...(parts.comparisonScope === undefined ? {} : { comparisonScope: parts.comparisonScope }),
    evidenceRefs: parts.evidenceRefs,
    counterpartyRole: fields.counterpartyRole,
    executionMode: fields.executionMode,
    ...(fields.conversationId === undefined ? {} : { conversationId: fields.conversationId }),
    ...(fields.requirementId === undefined ? {} : { requirementId: fields.requirementId }),
    ...(fields.vendorId === undefined ? {} : { vendorId: fields.vendorId }),
    ...(fields.rfqId === undefined ? {} : { rfqId: fields.rfqId }),
    ...(fields.supersedes === undefined ? {} : { supersedes: fields.supersedes }),
  });
  const decision = fields.requirementVersion === undefined
    ? decisionFields
    : { ...decisionFields, requirementVersion: fields.requirementVersion };
  // Quote lineage is SHA-256 over the canonical decision fields: the
  // stored contentHash and payloadSha256 carry the same digest.
  const canonical = canonicalJson(decision);
  const contentHash = await sha256HexOfCanonical(canonical);
  const payloadSha256 = contentHash;
  const storedTaxBasis = parts.taxBasis.kind === "unknown"
    ? {
      kind: "unknown" as const,
      reason: parts.taxBasis.reason,
      evidenceRefs: [...parts.taxBasis.evidenceRefs],
    }
    : parts.taxBasis.kind === "inclusive"
      ? {
        kind: "inclusive" as const,
        basisId: parts.taxBasis.basisId,
        evidenceRefs: [...parts.taxBasis.evidenceRefs],
      }
      : {
        kind: "exclusive" as const,
        basisId: parts.taxBasis.basisId,
        evidenceRefs: [...parts.taxBasis.evidenceRefs],
      };
  const quoteId = await ctx.db.insert("quotes", {
    organizationId: fields.organizationId,
    projectId: fields.projectId,
    ...(fields.conversationId === undefined ? {} : { conversationId: fields.conversationId }),
    ...(fields.requirementId === undefined ? {} : { requirementId: fields.requirementId }),
    ...(fields.vendorId === undefined ? {} : { vendorId: fields.vendorId }),
    ...(fields.rfqId === undefined ? {} : { rfqId: fields.rfqId }),
    ...(fields.requirementVersion === undefined ? {} : { requirementVersion: fields.requirementVersion }),
    version: quote.version,
    contentHash,
    payloadSha256,
    currency: parts.currency,
    lines: parts.lines.map((line) => ({ ...line, evidenceRefs: [...line.evidenceRefs] })),
    charges: parts.charges.map((charge) => ({ ...charge, evidenceRefs: [...charge.evidenceRefs] })),
    taxBasis: storedTaxBasis,
    ...(parts.comparisonScope === undefined
      ? {}
      : {
        comparisonScope: {
          ...parts.comparisonScope,
          items: parts.comparisonScope.items.map((item) => ({ ...item })),
        },
      }),
    evidenceRefs: [...parts.evidenceRefs],
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
    const fields: QuoteFields = {
      organizationId: args.organizationId,
      projectId: args.projectId,
      version: args.version,
      currency: args.currency,
      lines: [...args.lines],
      ...(args.charges === undefined ? {} : { charges: [...args.charges] }),
      taxBasis: args.taxBasis,
      ...(args.comparisonScope === undefined ? {} : { comparisonScope: args.comparisonScope }),
      ...(args.evidenceRefs === undefined ? {} : { evidenceRefs: [...args.evidenceRefs] }),
      counterpartyRole: "userImport",
      executionMode: "recorded",
      ...(args.conversationId === undefined ? {} : { conversationId: args.conversationId }),
      ...(args.requirementId === undefined ? {} : { requirementId: args.requirementId }),
      ...(args.vendorId === undefined ? {} : { vendorId: args.vendorId }),
      ...(args.rfqId === undefined ? {} : { rfqId: args.rfqId }),
      ...(args.supersedes === undefined ? {} : { supersedes: args.supersedes }),
    };
    const valid = validateQuoteFields(fields);
    if (!valid.ok) return { ok: false as const, code: valid.code, message: valid.message };
    const references = await checkQuoteReferences(ctx, args.organizationId, args.projectId, fields);
    if (!references.ok) {
      return { ok: false as const, code: references.code, message: references.message };
    }
    const fieldsWithLineage: QuoteFields = references.value.requirementVersion === undefined
      ? fields
      : { ...fields, requirementVersion: references.value.requirementVersion };
    const { quoteId, contentHash } = await insertQuoteVersion(ctx, fieldsWithLineage, valid.value, now);
    return { ok: true as const, quoteId, contentHash };
  },
});

/**
 * Internal provider write: extraction pipeline only, same proofs rules.
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
    const fields: QuoteFields = {
      organizationId: args.organizationId,
      projectId: args.projectId,
      version: args.version,
      currency: args.currency,
      lines: [...args.lines],
      ...(args.charges === undefined ? {} : { charges: [...args.charges] }),
      taxBasis: args.taxBasis,
      ...(args.comparisonScope === undefined ? {} : { comparisonScope: args.comparisonScope }),
      ...(args.evidenceRefs === undefined ? {} : { evidenceRefs: [...args.evidenceRefs] }),
      counterpartyRole: args.counterpartyRole,
      executionMode: args.executionMode,
      ...(args.conversationId === undefined ? {} : { conversationId: args.conversationId }),
      ...(args.requirementId === undefined ? {} : { requirementId: args.requirementId }),
      ...(args.vendorId === undefined ? {} : { vendorId: args.vendorId }),
      ...(args.rfqId === undefined ? {} : { rfqId: args.rfqId }),
      ...(args.supersedes === undefined ? {} : { supersedes: args.supersedes }),
    };
    const valid = validateQuoteFields(fields);
    if (!valid.ok) return { ok: false as const, code: valid.code, message: valid.message };
    const references = await checkQuoteReferences(ctx, args.organizationId, args.projectId, fields);
    if (!references.ok) {
      return { ok: false as const, code: references.code, message: references.message };
    }
    const fieldsWithLineage: QuoteFields = references.value.requirementVersion === undefined
      ? fields
      : { ...fields, requirementVersion: references.value.requirementVersion };
    const { quoteId, contentHash } = await insertQuoteVersion(ctx, fieldsWithLineage, valid.value, Date.now());
    return { ok: true as const, quoteId, contentHash };
  },
});

const compareResultValidator = v.union(
  v.object({
    ok: v.literal(true),
    status: v.union(
      v.literal("complete"),
      v.literal("estimated"),
      v.literal("incomplete"),
      v.literal("incompatible"),
    ),
    differenceMinorUnits: v.union(v.number(), v.null()),
    cheaper: v.union(v.string(), v.null()),
    estimatedDeltaRange: v.optional(v.object({ minimum: v.number(), maximum: v.number() })),
    reason: v.string(),
  }),
  denialValidator,
);

/** Exact-scope comparison over stable scope items; reorder-tolerant. */
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
    const result = compareStoredQuotes(
      {
        version: left.version,
        currency: left.currency,
        lines: left.lines.map((line) => ({ ...line, evidenceRefs: [...line.evidenceRefs] })),
        charges: left.charges.map((charge) => ({ ...charge, evidenceRefs: [...charge.evidenceRefs] })),
        taxBasis: left.taxBasis,
        ...(left.comparisonScope === undefined ? {} : { comparisonScope: left.comparisonScope }),
        evidenceRefs: [...left.evidenceRefs],
      },
      {
        version: right.version,
        currency: right.currency,
        lines: right.lines.map((line) => ({ ...line, evidenceRefs: [...line.evidenceRefs] })),
        charges: right.charges.map((charge) => ({ ...charge, evidenceRefs: [...charge.evidenceRefs] })),
        taxBasis: right.taxBasis,
        ...(right.comparisonScope === undefined ? {} : { comparisonScope: right.comparisonScope }),
        evidenceRefs: [...right.evidenceRefs],
      },
    );
    return {
      ok: true as const,
      status: result.status,
      differenceMinorUnits: result.differenceMinorUnits,
      cheaper: result.cheaper,
      ...(result.estimatedDeltaRange === undefined
        ? {}
        : { estimatedDeltaRange: { ...result.estimatedDeltaRange } }),
      reason: result.reason,
    };
  },
});
