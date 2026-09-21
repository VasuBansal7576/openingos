/**
 * E15 controlled sample guest project (PRD 11 evaluator path, P-16, H-06).
 *
 * A single atomic, idempotent boundary creates one fresh isolated guest
 * organization plus one EUR sample cafe project per caller-supplied
 * idempotency key. Identity always derives from `ctx.auth`; callers
 * supply no organization, project, or user identifier. The key is
 * bounded and normalized before any read or write beyond the
 * authentication check and the caller's own idempotency lookup; any
 * validation failure denies whole with zero new effect.
 *
 * Idempotency: the first submission with a key creates exactly one
 * guest organization, one project, finite owner authority, and the
 * fixed controlled dataset in one transaction. An exact replay returns
 * the stored project id with `deduplicated: true`. Distinct keys create
 * distinct fresh guest organizations and projects; organizations are
 * never reused across keys.
 *
 * Authority: every fresh guest organization owner membership and every
 * fresh guest project owner membership carries a finite horizon and
 * schedules the established `access/memberships:expireMembership`
 * transition in the same transaction, exactly as
 * access/memberships:createProject does for temporary grants.
 *
 * Dataset: the transaction seeds the controlled Northside cafe dataset
 * required by the PRD evaluator path. Every illustrative vendor,
 * evidence row, and quote carries `counterpartyRole: ownerStandIn`
 * with `executionMode: fixture` where the schema supports it, and the
 * project carries the durable controlled-sample marker surfaced by the
 * workbench projection. Exact comparison amounts run through the
 * existing stored quote semantics: EUR 7,950 delivery and installation
 * included versus EUR 7,500 plus EUR 600 delivery plus EUR 400
 * installation for EUR 8,500, an exact EUR 550 equivalent-scope
 * difference; an incomplete third offer that is never ranked; an
 * incompatible variant; a suitable vendor with an unpublished price;
 * and one labeled installed-equipment record.
 *
 * This module creates zero jobs, operations, grants, approvals,
 * reservations, conversations, recipient configs, provider IDs, email
 * sends, or external effects. Owner-only outreach stays unavailable:
 * no communication grant exists that could authorize a send.
 */

import { v } from "convex/values";
import { makeFunctionReference } from "convex/server";
import type { Id } from "../_generated/dataModel.js";
import { f1Mutation, type F1MutationCtx } from "../server.js";
import { denialValidator, identityOf } from "../access/checks.js";
import { recordCurrentAuthority } from "../access/memberships.js";
import { canonicalJson } from "../shared/hashing.js";
import { sha256HexOfCanonical } from "../shared/sha256.js";
import {
  candidateVariantKey,
  COMPATIBILITY_RULE_VERSION,
  normalizeBoundedText,
  REQUIREMENT_IDEMPOTENCY_KEY_MAX_LENGTH,
} from "../shared/domainContracts.js";
import {
  parseQuoteDocument,
  quoteDecisionFields,
  storedQuoteParts,
  type QuoteDocumentInput,
} from "../shared/quoteSemantics.js";

export const SAMPLE_GUEST_TTL_MS = 7 * 24 * 60 * 60 * 1000;
export const SAMPLE_KIND = "controlledSample";
export const SAMPLE_LABEL = "Controlled sample data";
export const SAMPLE_CURRENCY = "EUR";

const SAMPLE_NORMALIZED_PAYLOAD = canonicalJson({ dataset: "northside-cafe-sample-v1" });

const SAMPLE_SCOPE_REQUIREMENT = "northside-espresso-lot";
const SAMPLE_SCOPE_ID = "northside-espresso-scope";
const SAMPLE_SCOPE_380V_ID = "northside-espresso-scope-380v";
const SAMPLE_TAX_BASIS_ID = "NL-EUR-VAT-INCLUDED";

const SAMPLE_REQUIREMENT_KEY = "northside-espresso";

const expireMembershipRef = makeFunctionReference<
  "mutation",
  { membershipId: Id<"memberships"> },
  { ok: true; expired: boolean }
>("access/memberships:expireMembership");

const sampleResultValidator = v.union(
  v.object({
    ok: v.literal(true),
    projectId: v.id("projects"),
    organizationId: v.id("organizations"),
    deduplicated: v.boolean(),
  }),
  denialValidator,
);

function deny(code: string, message: string) {
  return { ok: false as const, code, message };
}

function sharedComparisonScope() {
  return {
    requirementId: SAMPLE_SCOPE_REQUIREMENT,
    scopeId: SAMPLE_SCOPE_ID,
    items: [
      {
        itemId: "espresso-package",
        lineId: "machine",
        unit: "piece",
        requiredQuantity: "1",
      },
    ],
  };
}

function inclusiveTaxBasis() {
  return { kind: "inclusive", basisId: SAMPLE_TAX_BASIS_ID, evidenceRefs: [] };
}

function machineLine(minorUnits: number) {
  return {
    lineId: "machine",
    description: "Two-group espresso machine, 220V (controlled demo)",
    quantity: "1",
    unitPrice: { currency: SAMPLE_CURRENCY, minorUnits },
    evidenceRefs: [],
  };
}

/**
 * Quote A: EUR 7,950 with delivery and installation explicitly included
 * in the machine line coverage. Complete through the accepted semantics.
 */
function quoteADocument(): QuoteDocumentInput {
  return {
    quoteId: "sample-quote-a",
    version: "sample-a-v1",
    currency: SAMPLE_CURRENCY,
    lines: [machineLine(795000)],
    charges: [
      {
        chargeId: "delivery",
        label: "Delivery",
        scope: { kind: "quote" },
        state: { kind: "included", coveringId: "machine" },
        evidenceRefs: [],
      },
      {
        chargeId: "installation",
        label: "Installation",
        scope: { kind: "quote" },
        state: { kind: "included", coveringId: "machine" },
        evidenceRefs: [],
      },
    ],
    taxBasis: inclusiveTaxBasis(),
    comparisonScope: sharedComparisonScope(),
    evidenceRefs: [],
  };
}

/**
 * Quote B: EUR 7,500 plus EUR 600 delivery plus EUR 400 installation,
 * totaling EUR 8,500. Complete through the accepted semantics.
 */
function quoteBDocument(): QuoteDocumentInput {
  return {
    quoteId: "sample-quote-b",
    version: "sample-b-v1",
    currency: SAMPLE_CURRENCY,
    lines: [machineLine(750000)],
    charges: [
      {
        chargeId: "delivery",
        label: "Delivery",
        scope: { kind: "quote" },
        state: { kind: "known", amount: { currency: SAMPLE_CURRENCY, minorUnits: 60000 } },
        evidenceRefs: [],
      },
      {
        chargeId: "installation",
        label: "Installation",
        scope: { kind: "quote" },
        state: { kind: "known", amount: { currency: SAMPLE_CURRENCY, minorUnits: 40000 } },
        evidenceRefs: [],
      },
    ],
    taxBasis: inclusiveTaxBasis(),
    comparisonScope: sharedComparisonScope(),
    evidenceRefs: [],
  };
}

/**
 * Quote C: incomplete third offer. The delivery charge is unknown, so
 * the accepted semantics keep both totals null and every pairwise
 * verdict incomplete: it is never ranked as cheapest.
 */
function quoteCDocument(): QuoteDocumentInput {
  return {
    quoteId: "sample-quote-c",
    version: "sample-c-v1",
    currency: SAMPLE_CURRENCY,
    lines: [machineLine(740000)],
    charges: [
      {
        chargeId: "delivery",
        label: "Delivery",
        scope: { kind: "quote" },
        state: { kind: "unknown", reason: "Freight not confirmed in the controlled demo terms" },
        evidenceRefs: [],
      },
    ],
    taxBasis: inclusiveTaxBasis(),
    comparisonScope: sharedComparisonScope(),
    evidenceRefs: [],
  };
}

/**
 * Quote D: complete offer for the incompatible 380V variant. Its own
 * total is exact, but its comparison scope differs, so every pairwise
 * verdict against the 220V offers is incompatible, never a delta.
 */
function quoteDDocument(): QuoteDocumentInput {
  return {
    quoteId: "sample-quote-d",
    version: "sample-d-v1",
    currency: SAMPLE_CURRENCY,
    lines: [
      {
        lineId: "machine",
        description: "Two-group espresso machine, 380V three-phase (controlled demo)",
        quantity: "1",
        unitPrice: { currency: SAMPLE_CURRENCY, minorUnits: 780000 },
        evidenceRefs: [],
      },
    ],
    charges: [
      {
        chargeId: "delivery",
        label: "Delivery",
        scope: { kind: "quote" },
        state: { kind: "known", amount: { currency: SAMPLE_CURRENCY, minorUnits: 30000 } },
        evidenceRefs: [],
      },
      {
        chargeId: "installation",
        label: "Installation",
        scope: { kind: "quote" },
        state: { kind: "known", amount: { currency: SAMPLE_CURRENCY, minorUnits: 10000 } },
        evidenceRefs: [],
      },
    ],
    taxBasis: inclusiveTaxBasis(),
    comparisonScope: {
      requirementId: SAMPLE_SCOPE_REQUIREMENT,
      scopeId: SAMPLE_SCOPE_380V_ID,
      items: [
        {
          itemId: "espresso-package-380v",
          lineId: "machine",
          unit: "piece",
          requiredQuantity: "1",
        },
      ],
    },
    evidenceRefs: [],
  };
}

async function insertSampleQuote(
  ctx: F1MutationCtx,
  input: {
    readonly organizationId: Id<"organizations">;
    readonly projectId: Id<"projects">;
    readonly requirementId: Id<"requirements">;
    readonly vendorId: Id<"vendors">;
    readonly document: QuoteDocumentInput;
    readonly createdAt: number;
  },
): Promise<Id<"quotes">> {
  const quote = parseQuoteDocument(input.document);
  const parts = storedQuoteParts(quote);
  const canonical = canonicalJson(
    quoteDecisionFields({
      organizationId: input.organizationId,
      projectId: input.projectId,
      version: quote.version,
      currency: parts.currency,
      lines: parts.lines,
      charges: parts.charges,
      taxBasis: parts.taxBasis,
      ...(parts.comparisonScope === undefined ? {} : { comparisonScope: parts.comparisonScope }),
      evidenceRefs: parts.evidenceRefs,
      counterpartyRole: "ownerStandIn",
      executionMode: "fixture",
      requirementId: input.requirementId,
      vendorId: input.vendorId,
    }),
  );
  const contentHash = await sha256HexOfCanonical(canonical);
  return await ctx.db.insert("quotes", {
    organizationId: input.organizationId,
    projectId: input.projectId,
    requirementId: input.requirementId,
    vendorId: input.vendorId,
    requirementVersion: 1,
    version: quote.version,
    contentHash,
    payloadSha256: contentHash,
    currency: parts.currency,
    lines: parts.lines.map((line) => ({ ...line, evidenceRefs: [...line.evidenceRefs] })),
    charges: parts.charges.map((charge) => ({ ...charge, evidenceRefs: [...charge.evidenceRefs] })),
    taxBasis: parts.taxBasis.kind === "unknown"
      ? {
        kind: "unknown" as const,
        reason: parts.taxBasis.reason,
        evidenceRefs: [...parts.taxBasis.evidenceRefs],
      }
      : {
        kind: parts.taxBasis.kind,
        basisId: parts.taxBasis.basisId,
        evidenceRefs: [...parts.taxBasis.evidenceRefs],
      },
    ...(parts.comparisonScope === undefined
      ? {}
      : {
        comparisonScope: {
          ...parts.comparisonScope,
          items: parts.comparisonScope.items.map((item) => ({ ...item })),
        },
      }),
    evidenceRefs: [...parts.evidenceRefs],
    counterpartyRole: "ownerStandIn",
    executionMode: "fixture",
    createdAt: input.createdAt,
  });
}

type SampleVendorSeed = {
  readonly suffix: string;
  readonly name: string;
  readonly variant: string;
  readonly compatibility: "pass" | "fail" | "unknown";
  readonly conversationState: "quoteReceived" | "awaitingReply";
  readonly document: (() => QuoteDocumentInput) | null;
};

const VENDOR_SEEDS: readonly SampleVendorSeed[] = [
  {
    suffix: "a",
    name: "Sample Vendor A (controlled demo)",
    variant: "220V standard",
    compatibility: "pass",
    conversationState: "quoteReceived",
    document: quoteADocument,
  },
  {
    suffix: "b",
    name: "Sample Vendor B (controlled demo)",
    variant: "220V standard",
    compatibility: "pass",
    conversationState: "quoteReceived",
    document: quoteBDocument,
  },
  {
    suffix: "c",
    name: "Sample Vendor C (controlled demo)",
    variant: "220V standard",
    compatibility: "unknown",
    conversationState: "quoteReceived",
    document: quoteCDocument,
  },
  {
    suffix: "d",
    name: "Sample Vendor D (controlled demo)",
    variant: "380V three-phase",
    compatibility: "fail",
    conversationState: "quoteReceived",
    document: quoteDDocument,
  },
  {
    suffix: "e",
    name: "Sample Vendor E (controlled demo)",
    variant: "220V standard",
    compatibility: "pass",
    conversationState: "awaitingReply",
    document: null,
  },
];

function compatibilityNote(seed: SampleVendorSeed): string {
  if (seed.compatibility === "pass") {
    return `pass: ${seed.variant} fits the recorded counter constraints (controlled demo)`;
  }
  if (seed.compatibility === "fail") {
    return `fail: ${seed.variant} supply is not recorded at the site (controlled demo)`;
  }
  return `unknown: ${seed.variant} fit is not yet evidenced (controlled demo)`;
}

/**
 * Create one fresh controlled sample guest project for one idempotency
 * key. Every structural check runs before the first write; the
 * transaction commits the guest organization, finite owner authority
 * with scheduled expiry, project, controlled dataset, and the
 * idempotency binding together, so a failure writes nothing.
 */
export const createSampleGuestProject = f1Mutation({
  args: { idempotencyKey: v.string() },
  returns: sampleResultValidator,
  handler: async (ctx, args) => {
    const identity = await identityOf(ctx);
    if (identity === null) {
      return deny("forged-identity", "unauthenticated");
    }
    let idempotencyKey: string;
    try {
      idempotencyKey = normalizeBoundedText(
        args.idempotencyKey,
        "idempotency key",
        REQUIREMENT_IDEMPOTENCY_KEY_MAX_LENGTH,
      );
    } catch (error) {
      return deny(
        "invalid-payload",
        error instanceof Error ? error.message : "idempotency key is invalid",
      );
    }

    const replay = await ctx.db
      .query("sampleProjectRequests")
      .withIndex("by_identity_and_key", (q) =>
        q.eq("identity", identity).eq("idempotencyKey", idempotencyKey),
      )
      .unique();
    if (replay !== null) {
      if (replay.normalizedPayload !== SAMPLE_NORMALIZED_PAYLOAD) {
        return deny("duplicate-conflict", "idempotency key already used with different sample details");
      }
      return {
        ok: true as const,
        projectId: replay.projectId,
        organizationId: replay.organizationId,
        deduplicated: true,
      };
    }

    // All quote documents parse through the accepted proofs constructors
    // before any write, so an invalid controlled document denies whole
    // with zero new effect.
    try {
      for (const seed of VENDOR_SEEDS) {
        if (seed.document !== null) parseQuoteDocument(seed.document());
      }
    } catch (error) {
      return deny(
        "invalid-payload",
        error instanceof Error ? error.message : "controlled sample quote is invalid",
      );
    }

    const now = Date.now();
    const expiresAt = now + SAMPLE_GUEST_TTL_MS;
    if (!Number.isSafeInteger(expiresAt) || !Number.isFinite(expiresAt) || expiresAt <= now) {
      return deny("invalid-payload", "sample guest authority horizon is invalid");
    }
    const needByAt = now + 90 * 24 * 60 * 60 * 1000;

    const organizationId = await ctx.db.insert("organizations", {
      name: "Northside sample cafe (controlled demo)",
      kind: "guest",
      createdAt: now,
    });
    const orgMembershipId = await ctx.db.insert("memberships", {
      organizationId,
      identity,
      role: "owner",
      status: "active",
      version: 1,
      expiresAt,
      updatedAt: now,
    });
    await recordCurrentAuthority(ctx, organizationId, undefined, identity, "owner", orgMembershipId, expiresAt, now);
    await ctx.scheduler.runAfter(SAMPLE_GUEST_TTL_MS, expireMembershipRef, {
      membershipId: orgMembershipId,
    });

    const locationId = await ctx.db.insert("locations", {
      organizationId,
      name: "Northside sample cafe location",
      region: "Netherlands",
      reportingCurrency: SAMPLE_CURRENCY,
      operatingStatus: "planned",
      createdAt: now,
    });

    const projectId = await ctx.db.insert("projects", {
      organizationId,
      name: "Northside sample cafe",
      visibility: "open",
      locationId,
      currency: SAMPLE_CURRENCY,
      budgetMinorUnits: 1200000,
      needByAt,
      createdAt: now,
      sampleKind: SAMPLE_KIND,
      sampleLabel: SAMPLE_LABEL,
    });
    const projectMembershipId = await ctx.db.insert("memberships", {
      organizationId,
      projectId,
      identity,
      role: "owner",
      status: "active",
      version: 1,
      expiresAt,
      updatedAt: now,
    });
    await recordCurrentAuthority(
      ctx,
      organizationId,
      projectId,
      identity,
      "owner",
      projectMembershipId,
      expiresAt,
      now,
    );
    await ctx.scheduler.runAfter(SAMPLE_GUEST_TTL_MS, expireMembershipRef, {
      membershipId: projectMembershipId,
    });

    const requirementId = await ctx.db.insert("requirements", {
      organizationId,
      projectId,
      key: SAMPLE_REQUIREMENT_KEY,
      title: "Espresso equipment package",
      category: "espresso",
      quantity: "1",
      unit: "lot",
      priority: "P0",
      state: "approved",
      fulfillment: "notOrdered",
      version: 1,
      budgetMinorUnits: 1000000,
      currency: SAMPLE_CURRENCY,
      needByAt,
      hardConstraints: "Counter space for a two-group machine, 220V supply, water treatment (controlled demo brief)",
      createdAt: now,
      updatedAt: now,
    });

    const model = "Sample two-group espresso machine";
    let createdAt = now;
    for (const seed of VENDOR_SEEDS) {
      createdAt += 1;
      const vendorId = await ctx.db.insert("vendors", {
        organizationId,
        name: seed.name,
        regions: ["NL"],
        serviceCoverage: "Netherlands (controlled demo record)",
        serviceCheckedAt: now,
        createdAt,
      });
      const candidateId = await ctx.db.insert("candidates", {
        organizationId,
        projectId,
        requirementId,
        vendorId,
        productModel: model,
        variant: seed.variant,
        variantKey: candidateVariantKey({
          requirementId,
          productModel: model,
          variant: seed.variant,
          vendorId,
        }),
        compatibility: seed.compatibility,
        ...(seed.compatibility === "unknown"
          ? {}
          : {
            compatibilityRequirementVersion: 1,
            compatibilityRuleVersion: COMPATIBILITY_RULE_VERSION,
            compatibilityEvidenceIndexComplete: true,
          }),
        conversationState: seed.conversationState,
        createdAt,
      });
      if (seed.compatibility !== "unknown") {
        const evidenceId = await ctx.db.insert("productEvidence", {
          organizationId,
          projectId,
          requirementId,
          candidateId,
          field: "compatibility",
          sourceKind: "controlled-sample",
          capturedAt: now,
          originalValue: "Controlled sample compatibility record",
          normalizedValue: compatibilityNote(seed),
          verification: "verified",
          freshness: "fresh",
          counterpartyRole: "ownerStandIn",
          executionMode: "fixture",
          origin: "internal",
          conflictEvidenceIds: [],
          idempotencyKey: `sample-compat-${seed.suffix}`,
          version: "1",
          createdAt,
        });
        await ctx.db.insert("compatibilityEvidenceBindings", {
          organizationId,
          projectId,
          candidateId,
          evidenceId,
          evidenceVersion: "1",
        });
        await ctx.db.patch(candidateId, {
          compatibilityEvidenceRefs: [{ sourceId: evidenceId, version: "1" }],
        });
      }
      if (seed.document !== null) {
        await insertSampleQuote(ctx, {
          organizationId,
          projectId,
          requirementId,
          vendorId,
          document: seed.document(),
          createdAt: createdAt + 1000,
        });
      }
    }

    const assetId = await ctx.db.insert("assets", {
      organizationId,
      projectId,
      label: "Sample espresso machine (controlled demo)",
      constraints: "220V counter clearance (controlled demo)",
      purchaseProvenance: "controlled sample record",
      idempotencyKey: "sample-asset-1",
      createdAt: now,
    });
    await ctx.db.insert("assetDocuments", {
      organizationId,
      projectId,
      assetId,
      kind: "purchase",
      idempotencyKey: "sample-asset-document-purchase",
      createdAt: now,
    });
    await ctx.db.insert("assetDocuments", {
      organizationId,
      projectId,
      assetId,
      kind: "warranty",
      idempotencyKey: "sample-asset-document-warranty",
      createdAt: now,
    });

    await ctx.db.insert("projectEvents", {
      organizationId,
      projectId,
      kind: "sample.created",
      actor: identity,
      createdAt: now,
    });
    await ctx.db.insert("projectEvents", {
      organizationId,
      projectId,
      kind: "requirement.created",
      actor: identity,
      createdAt: now,
    });
    await ctx.db.insert("projectEvents", {
      organizationId,
      projectId,
      kind: "asset.created",
      actor: identity,
      createdAt: now,
    });

    await ctx.db.insert("sampleProjectRequests", {
      identity,
      idempotencyKey,
      normalizedPayload: SAMPLE_NORMALIZED_PAYLOAD,
      organizationId,
      projectId,
      createdAt: now,
    });

    return { ok: true as const, projectId, organizationId, deduplicated: false };
  },
});
