/**
 * P-01 project intake (controlled contract, PRD 10 / P-01).
 *
 * A single atomic, idempotent workspace boundary for the three supported
 * entry points: opening, quote comparison, and equipment case. Identity
 * always derives from `ctx.auth`; callers supply no organization, project,
 * or user identifier. Bounded inputs are normalized before any read or
 * write beyond the authentication check and the caller's own idempotency
 * lookup; any validation failure denies whole with zero new effect.
 *
 * Idempotency: the caller supplies a bounded key. The first submission
 * with a key creates exactly one organization reuse plus one project,
 * owner authority, minimal initial records, and material history in one
 * transaction. An exact replay returns the stored project id with
 * `deduplicated: true`; the same key with different normalized fields
 * conflicts whole and creates nothing. Concurrent same-key submissions
 * serialize on the compound identity/key index inside the transaction,
 * so the second observes the first row and replays instead of creating
 * a second workspace.
 *
 * This module launches no research, creates no grants, reserves no
 * money, contacts no provider, and infers no supplier evidence.
 */

import { v } from "convex/values";
import type { Id } from "../_generated/dataModel.js";
import { f1Mutation, type F1MutationCtx } from "../server.js";
import { denialValidator, identityOf, membershipScopeKey } from "../access/checks.js";
import { recordCurrentAuthority } from "../access/memberships.js";
import { canonicalJson } from "../shared/hashing.js";
import {
  normalizeBoundedText,
  normalizeRequirementDate,
  REQUIREMENT_CATEGORY_MAX_LENGTH,
  REQUIREMENT_HARD_CONSTRAINTS_MAX_LENGTH,
  REQUIREMENT_IDEMPOTENCY_KEY_MAX_LENGTH,
  REQUIREMENT_TITLE_MAX_LENGTH,
} from "../shared/domainContracts.js";
import { currencyCode, money as makeMoney } from "../../proofs/money/money.js";
import {
  decimalCompare,
  decimalToString,
  decimalZero,
  quantity,
} from "../../proofs/money/decimal.js";

const INTAKE_MODE_VALIDATOR = v.union(
  v.literal("opening"),
  v.literal("quoteComparison"),
  v.literal("equipment"),
);

const WORKSPACE_KIND_VALIDATOR = v.union(v.literal("guest"), v.literal("private"));

const URGENCY_VALIDATOR = v.union(
  v.literal("urgent"),
  v.literal("high"),
  v.literal("normal"),
  v.literal("low"),
);

export const intakeInputValidator = v.object({
  idempotencyKey: v.string(),
  mode: INTAKE_MODE_VALIDATOR,
  projectName: v.string(),
  workspaceKind: v.optional(WORKSPACE_KIND_VALIDATOR),
  region: v.optional(v.string()),
  currency: v.optional(v.string()),
  needByAt: v.optional(v.number()),
  budgetMinorUnits: v.optional(v.number()),
  detailTitle: v.optional(v.string()),
  detailCategory: v.optional(v.string()),
  detailSummary: v.optional(v.string()),
  urgency: v.optional(URGENCY_VALIDATOR),
});

const intakeResultValidator = v.union(
  v.object({
    ok: v.literal(true),
    projectId: v.id("projects"),
    organizationId: v.id("organizations"),
    deduplicated: v.boolean(),
  }),
  denialValidator,
);

const PROJECT_NAME_MAX_LENGTH = 100;
const REGION_MAX_LENGTH = 128;
const DETAIL_TITLE_MAX_LENGTH = 256;
const DETAIL_CATEGORY_MAX_LENGTH = 128;
const DETAIL_SUMMARY_MAX_LENGTH = 2_000;
const SERVICE_SUMMARY_MAX_LENGTH = 800;
const ORG_NAME_MAX_LENGTH = 128;
const LOCATION_NAME_MAX_LENGTH = 128;
const MAX_OWNED_AUTHORITY_SCAN = 64;

type IntakeMode = "opening" | "quoteComparison" | "equipment";
type WorkspaceKind = "guest" | "private";
type IntakeUrgency = "urgent" | "high" | "normal" | "low";

interface NormalizedIntake {
  readonly idempotencyKey: string;
  readonly mode: IntakeMode;
  readonly projectName: string;
  readonly workspaceKind: WorkspaceKind;
  readonly region: string | undefined;
  readonly currency: string;
  readonly needByAt: number | undefined;
  readonly budgetMinorUnits: number | undefined;
  readonly detailTitle: string | undefined;
  readonly detailCategory: string | undefined;
  readonly detailSummary: string | undefined;
  readonly urgency: IntakeUrgency;
}

function deny(code: string, message: string) {
  return { ok: false as const, code, message };
}

function normalizeOptionalText(
  raw: string | undefined,
  label: string,
  maxLength: number,
): string | undefined {
  if (raw === undefined) return undefined;
  return normalizeBoundedText(raw, label, maxLength);
}

function normalizeIntake(raw: {
  readonly idempotencyKey: string;
  readonly mode: IntakeMode;
  readonly projectName: string;
  readonly workspaceKind?: WorkspaceKind;
  readonly region?: string;
  readonly currency?: string;
  readonly needByAt?: number;
  readonly budgetMinorUnits?: number;
  readonly detailTitle?: string;
  readonly detailCategory?: string;
  readonly detailSummary?: string;
  readonly urgency?: IntakeUrgency;
}): NormalizedIntake {
  const idempotencyKey = normalizeBoundedText(
    raw.idempotencyKey,
    "idempotency key",
    REQUIREMENT_IDEMPOTENCY_KEY_MAX_LENGTH,
  );
  if (raw.mode !== "opening" && raw.mode !== "quoteComparison" && raw.mode !== "equipment") {
    throw new Error("intake mode is invalid");
  }
  const projectName = normalizeBoundedText(raw.projectName, "project name", PROJECT_NAME_MAX_LENGTH);
  const workspaceKind: WorkspaceKind = raw.workspaceKind ?? "private";
  if (workspaceKind !== "guest" && workspaceKind !== "private") {
    throw new Error("workspace kind is invalid");
  }
  const region = normalizeOptionalText(raw.region, "region", REGION_MAX_LENGTH);
  let currency = "EUR";
  if (raw.currency !== undefined) {
    currency = currencyCode(normalizeBoundedText(raw.currency, "currency", 3));
  }
  let needByAt: number | undefined;
  if (raw.needByAt !== undefined) {
    needByAt = normalizeRequirementDate(raw.needByAt);
  }
  let budgetMinorUnits: number | undefined;
  if (raw.budgetMinorUnits !== undefined) {
    if (!Number.isSafeInteger(raw.budgetMinorUnits) || raw.budgetMinorUnits < 0) {
      throw new Error("budget amount must be a non-negative safe integer");
    }
    makeMoney(currency, raw.budgetMinorUnits);
    budgetMinorUnits = raw.budgetMinorUnits;
  }
  const detailTitle = normalizeOptionalText(raw.detailTitle, "detail title", DETAIL_TITLE_MAX_LENGTH);
  const detailCategory = normalizeOptionalText(
    raw.detailCategory,
    "detail category",
    DETAIL_CATEGORY_MAX_LENGTH,
  );
  const detailSummary = normalizeOptionalText(
    raw.detailSummary,
    "detail summary",
    DETAIL_SUMMARY_MAX_LENGTH,
  );
  const urgency: IntakeUrgency = raw.urgency ?? "normal";
  if (urgency !== "urgent" && urgency !== "high" && urgency !== "normal" && urgency !== "low") {
    throw new Error("urgency is invalid");
  }
  if (raw.mode === "opening") {
    if (region === undefined) throw new Error("region required for an opening");
  }
  if (raw.mode === "quoteComparison") {
    if (detailTitle === undefined) throw new Error("quote subject required for a quote comparison");
  }
  if (raw.mode === "equipment") {
    if (detailTitle === undefined) throw new Error("equipment label required for an equipment case");
    if (detailSummary === undefined) throw new Error("issue summary required for an equipment case");
    if (detailSummary.length > SERVICE_SUMMARY_MAX_LENGTH) {
      throw new Error("issue summary exceeds the supported length");
    }
  }
  return {
    idempotencyKey,
    mode: raw.mode,
    projectName,
    workspaceKind,
    region,
    currency,
    needByAt,
    budgetMinorUnits,
    detailTitle,
    detailCategory,
    detailSummary,
    urgency,
  };
}

function normalizedPayloadOf(input: NormalizedIntake): string {
  return canonicalJson({
    budgetMinorUnits: input.budgetMinorUnits ?? null,
    currency: input.currency,
    detailCategory: input.detailCategory ?? null,
    detailSummary: input.detailSummary ?? null,
    detailTitle: input.detailTitle ?? null,
    mode: input.mode,
    needByAt: input.needByAt ?? null,
    projectName: input.projectName,
    region: input.region ?? null,
    urgency: input.urgency,
    workspaceKind: input.workspaceKind,
  });
}

/**
 * Reuse the caller's own organization of the requested kind when one
 * exists: the newest currently valid org-scoped owner authority row wins.
 * The scan reads only the caller's own authority rows through the exact
 * identity index, so another tenant's organizations are never visible.
 */
async function findCallerOwnedOrganization(
  ctx: F1MutationCtx,
  identity: string,
  kind: WorkspaceKind,
  now: number,
): Promise<Id<"organizations"> | null> {
  const rows = await ctx.db
    .query("membershipAuthorities")
    .withIndex("by_identity_and_authority_until_and_organization_and_project", (q) =>
      q.eq("identity", identity),
    )
    .order("desc")
    .take(MAX_OWNED_AUTHORITY_SCAN);
  const candidates: { readonly organizationId: Id<"organizations">; readonly authorityUntil: number }[] = [];
  for (const row of rows) {
    if (
      row.scopeKey !== membershipScopeKey(undefined) ||
      row.role !== "owner" ||
      row.projectId !== undefined ||
      row.authorityUntil <= now ||
      (row.expiresAt !== undefined && row.expiresAt <= now)
    ) {
      continue;
    }
    candidates.push({ organizationId: row.organizationId, authorityUntil: row.authorityUntil });
  }
  candidates.sort((left, right) => right.authorityUntil - left.authorityUntil);
  for (const candidate of candidates) {
    const organization = await ctx.db.get(candidate.organizationId);
    if (organization === null || organization.kind !== kind) continue;
    return organization._id;
  }
  return null;
}

interface IntakeRecords {
  readonly requirementKey: string;
  readonly requirementTitle: string;
  readonly requirementCategory: string;
  readonly requirementUnit: string;
  readonly requirementPriority: "P0" | "P1" | "P2";
  readonly requirementHardConstraints: string | undefined;
}

function recordsFor(input: NormalizedIntake): IntakeRecords {
  if (input.mode === "opening") {
    return {
      requirementKey: "opening-scope",
      requirementTitle: "Opening purchasing scope",
      requirementCategory: "equipment",
      requirementUnit: "scope",
      requirementPriority: "P0",
      requirementHardConstraints: input.region === undefined
        ? undefined
        : `Primary region: ${input.region}`,
    };
  }
  if (input.mode === "quoteComparison") {
    return {
      requirementKey: "quote-comparison",
      requirementTitle: input.detailTitle ?? "Quote comparison",
      requirementCategory: input.detailCategory ?? "equipment",
      requirementUnit: "lot",
      requirementPriority: "P1",
      requirementHardConstraints: input.detailSummary,
    };
  }
  return {
    requirementKey: "equipment-case",
    requirementTitle: input.detailTitle ?? "Equipment service need",
    requirementCategory: "service",
    requirementUnit: "case",
    requirementPriority: "P1",
    requirementHardConstraints: undefined,
  };
}

/**
 * Create one workspace for one intake key. Every structural check runs
 * before the first write; the transaction commits the organization
 * reuse/creation, project plus current owner authority, minimal initial
 * records, material history, and the idempotency binding together, so a
 * failure writes nothing.
 */
export const createWorkspace = f1Mutation({
  args: intakeInputValidator.fields,
  returns: intakeResultValidator,
  handler: async (ctx, args) => {
    const identity = await identityOf(ctx);
    if (identity === null) {
      return deny("forged-identity", "unauthenticated");
    }
    let input: NormalizedIntake;
    try {
      input = normalizeIntake({
        idempotencyKey: args.idempotencyKey,
        mode: args.mode,
        projectName: args.projectName,
        ...(args.workspaceKind === undefined ? {} : { workspaceKind: args.workspaceKind }),
        ...(args.region === undefined ? {} : { region: args.region }),
        ...(args.currency === undefined ? {} : { currency: args.currency }),
        ...(args.needByAt === undefined ? {} : { needByAt: args.needByAt }),
        ...(args.budgetMinorUnits === undefined ? {} : { budgetMinorUnits: args.budgetMinorUnits }),
        ...(args.detailTitle === undefined ? {} : { detailTitle: args.detailTitle }),
        ...(args.detailCategory === undefined ? {} : { detailCategory: args.detailCategory }),
        ...(args.detailSummary === undefined ? {} : { detailSummary: args.detailSummary }),
        ...(args.urgency === undefined ? {} : { urgency: args.urgency }),
      });
    } catch (error) {
      return deny(
        "invalid-payload",
        error instanceof Error ? error.message : "intake details are invalid",
      );
    }
    // Quantity/unit anchors for the minimal initial requirement validate
    // through the accepted proofs/money contract before any side effect.
    let normalizedQuantity: string;
    try {
      const parsed = quantity("1");
      if (decimalCompare(parsed, decimalZero()) <= 0) {
        return deny("invalid-payload", "intake quantity must be positive");
      }
      normalizedQuantity = decimalToString(parsed);
    } catch {
      return deny("invalid-payload", "intake quantity is invalid");
    }
    const records = recordsFor(input);
    try {
      normalizeBoundedText(records.requirementTitle, "title", REQUIREMENT_TITLE_MAX_LENGTH);
      normalizeBoundedText(records.requirementCategory, "category", REQUIREMENT_CATEGORY_MAX_LENGTH);
      if (records.requirementHardConstraints !== undefined) {
        normalizeBoundedText(
          records.requirementHardConstraints,
          "hard constraints",
          REQUIREMENT_HARD_CONSTRAINTS_MAX_LENGTH,
        );
      }
    } catch (error) {
      return deny(
        "invalid-payload",
        error instanceof Error ? error.message : "intake requirement is invalid",
      );
    }
    const normalizedPayload = normalizedPayloadOf(input);

    const replay = await ctx.db
      .query("intakeRequests")
      .withIndex("by_identity_and_key", (q) =>
        q.eq("identity", identity).eq("idempotencyKey", input.idempotencyKey),
      )
      .unique();
    if (replay !== null) {
      if (replay.normalizedPayload !== normalizedPayload) {
        return deny("duplicate-conflict", "idempotency key already used with different intake details");
      }
      return {
        ok: true as const,
        projectId: replay.projectId,
        organizationId: replay.organizationId,
        deduplicated: true,
      };
    }

    const now = Date.now();
    const organizationId =
      (await findCallerOwnedOrganization(ctx, identity, input.workspaceKind, now)) ??
      (await (async (): Promise<Id<"organizations">> => {
        const name = normalizeBoundedText(
          `${input.projectName} workspace`.slice(0, ORG_NAME_MAX_LENGTH),
          "organization name",
          ORG_NAME_MAX_LENGTH,
        );
        const created = await ctx.db.insert("organizations", {
          name,
          kind: input.workspaceKind,
          createdAt: now,
        });
        const membershipId = await ctx.db.insert("memberships", {
          organizationId: created,
          identity,
          role: "owner",
          status: "active",
          version: 1,
          updatedAt: now,
        });
        await recordCurrentAuthority(
          ctx,
          created,
          undefined,
          identity,
          "owner",
          membershipId,
          undefined,
          now,
        );
        return created;
      })());

    let locationId: Id<"locations"> | undefined;
    if (input.region !== undefined) {
      locationId = await ctx.db.insert("locations", {
        organizationId,
        name: normalizeBoundedText(
          `${input.projectName} location`.slice(0, LOCATION_NAME_MAX_LENGTH),
          "location name",
          LOCATION_NAME_MAX_LENGTH,
        ),
        region: input.region,
        reportingCurrency: input.currency,
        operatingStatus: "planned",
        createdAt: now,
      });
    }

    const projectId = await ctx.db.insert("projects", {
      organizationId,
      name: input.projectName,
      visibility: input.workspaceKind === "guest" ? "open" : "restricted",
      ...(locationId === undefined ? {} : { locationId }),
      currency: input.currency,
      ...(input.budgetMinorUnits === undefined ? {} : { budgetMinorUnits: input.budgetMinorUnits }),
      ...(input.needByAt === undefined ? {} : { needByAt: input.needByAt }),
      createdAt: now,
    });
    const projectMembershipId = await ctx.db.insert("memberships", {
      organizationId,
      projectId,
      identity,
      role: "owner",
      status: "active",
      version: 1,
      updatedAt: now,
    });
    await recordCurrentAuthority(
      ctx,
      organizationId,
      projectId,
      identity,
      "owner",
      projectMembershipId,
      undefined,
      now,
    );

    const requirementId = await ctx.db.insert("requirements", {
      organizationId,
      projectId,
      key: records.requirementKey,
      title: records.requirementTitle,
      category: records.requirementCategory,
      quantity: normalizedQuantity,
      unit: records.requirementUnit,
      priority: records.requirementPriority,
      state: "draft",
      fulfillment: "notOrdered",
      version: 1,
      ...(input.budgetMinorUnits === undefined ? {} : { budgetMinorUnits: input.budgetMinorUnits }),
      currency: input.currency,
      ...(input.needByAt === undefined ? {} : { needByAt: input.needByAt }),
      ...(records.requirementHardConstraints === undefined
        ? {}
        : { hardConstraints: records.requirementHardConstraints }),
      createdAt: now,
      updatedAt: now,
    });

    await ctx.db.insert("projectEvents", {
      organizationId,
      projectId,
      kind: "intake.created",
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

    if (input.mode === "equipment") {
      const assetLabel = input.detailTitle ?? `${input.projectName} equipment`;
      const assetId = await ctx.db.insert("assets", {
        organizationId,
        projectId,
        label: assetLabel,
        idempotencyKey: `${input.idempotencyKey}:asset`,
        createdAt: now,
      });
      const caseId = await ctx.db.insert("serviceCases", {
        organizationId,
        projectId,
        assetId,
        urgency: input.urgency,
        summary: input.detailSummary ?? "Service case opened from intake.",
        state: "open",
        idempotencyKey: `${input.idempotencyKey}:case`,
        createdAt: now,
        updatedAt: now,
      });
      await ctx.db.insert("projectEvents", {
        organizationId,
        projectId,
        kind: "asset.created",
        actor: identity,
        createdAt: now,
      });
      await ctx.db.insert("projectEvents", {
        organizationId,
        projectId,
        kind: "serviceCase.created",
        actor: identity,
        createdAt: now,
      });
      void caseId;
      void requirementId;
    }

    await ctx.db.insert("intakeRequests", {
      identity,
      idempotencyKey: input.idempotencyKey,
      normalizedPayload,
      organizationId,
      projectId,
      createdAt: now,
    });

    return { ok: true as const, projectId, organizationId, deduplicated: false };
  },
});

export const createIntakeWorkspace = createWorkspace;
export const createProjectIntake = createWorkspace;
