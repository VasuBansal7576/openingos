/**
 * F1 workspace graph (controlled contract, PRD 30).
 *
 * Evidence watches, the append-only project event log, risks, and
 * organization-owned reusable templates. Template instantiation copies
 * requirements and constraints into the target project only: historical
 * orders, order events, payments, settled costs, refunds, and credits
 * are never copied, so reuse cannot inherit another project's
 * commitments or cash.
 *
 * P-19 second-location reuse: a template instantiated into a different
 * target project keeps the reusable specification facts (key, title,
 * category, quantity, unit) while every current commercial or
 * operational fact is explicitly revalidation-required by construction.
 * The reuse summary is derived from the template version and target
 * project only: it never claims a price, availability, supplier reply,
 * or service outcome, and never claims stale evidence exists when none
 * was copied — each current fact states `revalidationRequired` with
 * `checked: false` and a reason tied to the template version and target
 * project.
 */

import { v } from "convex/values";
import type { Id } from "../_generated/dataModel.js";
import { f1InternalMutation, f1Mutation, f1Query } from "../server.js";
import { denialValidator } from "../access/checks.js";
import {
  decimalCompare,
  decimalToString,
  decimalZero,
  quantity,
} from "../../proofs/money/decimal.js";
import {
  TEMPLATE_REUSE_COLLECTIONS,
  dependencyCreatesCycle,
  projectEventInputValidator,
  riskInputValidator,
  templateInputValidator,
  templateReuseExcludesHistoricFinancials,
  watchInputValidator,
} from "../shared/domainContracts.js";
import { requireDomainAccess, requireOwnedRef } from "./guards.js";

/**
 * F1R-07: normalized watch-evidence equality. Refs compare as a set of
 * source/version/locator triples so order never distinguishes a replay,
 * while any changed, added, or removed reference conflicts.
 */
function sameWatchEvidenceRefs(
  existing:
    | readonly { readonly sourceId: string; readonly version: string; readonly locator?: string }[]
    | undefined,
  wanted:
    | readonly { readonly sourceId: string; readonly version: string; readonly locator?: string }[]
    | undefined,
): boolean {
  const normalize = (
    refs: readonly { readonly sourceId: string; readonly version: string; readonly locator?: string }[],
  ) => refs.map((ref) => `${ref.sourceId}|${ref.version}|${ref.locator ?? ""}`).sort();
  const left = normalize(existing ?? []);
  const right = normalize(wanted ?? []);
  return left.length === right.length && left.every((entry, index) => entry === right[index]);
}

type WatchCandidate = {
  readonly _id: Id<"candidates">;
  readonly organizationId: Id<"organizations">;
  readonly projectId: Id<"projects">;
  readonly requirementId: Id<"requirements">;
  readonly vendorId: Id<"vendors">;
};

type WatchRequirement = {
  readonly _id: Id<"requirements">;
  readonly organizationId: Id<"organizations">;
  readonly projectId: Id<"projects">;
};

/**
 * Resolve every watch relationship before any replay lookup or write. A
 * watch is currently candidate-only, and its evidence refs must identify
 * exact productEvidence revisions owned by this project and related either
 * directly to that candidate or to its requirement.
 */
async function validateWatchTarget(
  ctx: Parameters<typeof requireDomainAccess>[0],
  organizationId: Id<"organizations">,
  projectId: Id<"projects">,
  candidateId: Id<"candidates">,
  evidenceRefs:
    | readonly { readonly sourceId: string; readonly version: string; readonly locator?: string }[]
    | undefined,
): Promise<{ ok: true } | { ok: false; code: string; message: string }> {
  const candidate = await requireOwnedRef(
    await ctx.db.get(candidateId),
    organizationId,
    projectId,
  );
  if (!candidate.ok) {
    return { ok: false as const, code: candidate.code, message: candidate.message };
  }
  const candidateValue: WatchCandidate = candidate.value;
  const requirement = await requireOwnedRef(
    await ctx.db.get(candidateValue.requirementId),
    organizationId,
    projectId,
  );
  if (!requirement.ok) {
    return { ok: false as const, code: requirement.code, message: requirement.message };
  }
  const requirementValue: WatchRequirement = requirement.value;
  const vendor = await ctx.db.get(candidateValue.vendorId);
  if (vendor === null || vendor.organizationId !== organizationId) {
    return { ok: false as const, code: "denied-project", message: "candidate vendor is not in this organization" };
  }
  for (const ref of evidenceRefs ?? []) {
    const evidenceId = ctx.db.normalizeId("productEvidence", ref.sourceId);
    if (evidenceId === null) {
      return { ok: false as const, code: "unknown-evidence", message: "watch evidence does not resolve" };
    }
    const evidence = await ctx.db.get(evidenceId);
    if (evidence === null) {
      return { ok: false as const, code: "unknown-evidence", message: "watch evidence does not resolve" };
    }
    if (
      evidence.organizationId !== organizationId ||
      evidence.projectId !== projectId
    ) {
      return { ok: false as const, code: "denied-project", message: "watch evidence is not in this project" };
    }
    if (evidence.version !== ref.version) {
      return { ok: false as const, code: "stale-evidence", message: "watch evidence version changed" };
    }
    if (evidence.candidateId !== undefined) {
      if (evidence.candidateId !== candidateValue._id) {
        return { ok: false as const, code: "unrelated-evidence", message: "watch evidence concerns another candidate" };
      }
    } else if (evidence.requirementId !== requirementValue._id) {
      return { ok: false as const, code: "unrelated-evidence", message: "watch evidence concerns another requirement" };
    }
  }
  return { ok: true as const };
}

/**
 * Create an evidence watch on a candidate (explicit owner-import path).
 * The target and every evidence revision are resolved inside the authorized
 * project before replay handling or insertion; the source is fixed to
 * `ownerImport` so a public caller can never claim internal pipeline
 * verification. The next check time derives server-side from cadence.
 * Replays through the idempotency key return the existing watch or conflict
 * on divergence.
 */
export const createWatch = f1Mutation({
  args: watchInputValidator.fields,
  returns: v.union(
    v.object({ ok: v.literal(true), watchId: v.id("watches"), deduplicated: v.boolean() }),
    denialValidator,
  ),
  handler: async (ctx, args) => {
    const access = await requireDomainAccess(
      ctx,
      args.organizationId,
      args.projectId,
      "contributor",
    );
    if (!access.ok) {
      return { ok: false as const, code: access.code, message: access.message };
    }
    if (args.idempotencyKey.trim().length === 0) {
      return { ok: false as const, code: "invalid-payload", message: "idempotency key required" };
    }
    if (!Number.isInteger(args.cadenceMs) || args.cadenceMs <= 0) {
      return { ok: false as const, code: "invalid-payload", message: "cadence must be positive" };
    }
    // Resolve the complete target graph, including evidence provenance,
    // before consulting the replay key. This keeps a malformed or foreign
    // retry from being accepted as an existing watch and guarantees that a
    // failed request cannot create a watch or any related append-only row.
    const target = await validateWatchTarget(
      ctx,
      args.organizationId,
      args.projectId,
      args.targetId,
      args.evidenceRefs,
    );
    if (!target.ok) return target;
    const existing = await ctx.db
      .query("watches")
      .withIndex("by_project_and_key", (q) =>
        q.eq("projectId", args.projectId).eq("idempotencyKey", args.idempotencyKey),
      )
      .unique();
    if (existing !== null) {
      if (existing.organizationId !== args.organizationId) {
        return { ok: false as const, code: "denied-project", message: "reference is not in this project" };
      }
      const sameJob = (existing.jobId ?? undefined) === args.jobId;
      // F1R-07: replay identity includes the evidence references in
      // normalized form, so a watch retargeted at different evidence
      // conflicts instead of replaying the old observation.
      if (
        !sameJob ||
        existing.targetKind !== args.targetKind ||
        existing.targetId !== args.targetId ||
        existing.cadenceMs !== args.cadenceMs ||
        existing.counterpartyRole !== args.counterpartyRole ||
        !sameWatchEvidenceRefs(existing.evidenceRefs, args.evidenceRefs)
      ) {
        return { ok: false as const, code: "duplicate-conflict", message: "idempotency key already used with different fields" };
      }
      return { ok: true as const, watchId: existing._id, deduplicated: true };
    }
    if (args.jobId !== undefined) {
      const job = await ctx.db.get(args.jobId);
      if (
        job === null ||
        job.organizationId !== args.organizationId ||
        job.projectId !== args.projectId
      ) {
        return { ok: false as const, code: "denied-project", message: "job is not in this project" };
      }
    }
    const now = Date.now();
    const watchId = await ctx.db.insert("watches", {
      organizationId: args.organizationId,
      projectId: args.projectId,
      ...(args.jobId === undefined ? {} : { jobId: args.jobId }),
      targetKind: args.targetKind,
      targetId: args.targetId,
      cadenceMs: args.cadenceMs,
      nextCheckAt: now + args.cadenceMs,
      state: "active",
      lastResult: "unknown",
      source: "ownerImport",
      counterpartyRole: args.counterpartyRole,
      ...(args.evidenceRefs === undefined ? {} : { evidenceRefs: [...args.evidenceRefs] }),
      idempotencyKey: args.idempotencyKey,
      createdAt: now,
    });
    return { ok: true as const, watchId, deduplicated: false };
  },
});

/**
 * Record an explicit owner-import watch check result; the watch must be
 * in-project. The next check time advances server-side from cadence.
 */
export const checkWatch = f1Mutation({
  args: {
    organizationId: v.id("organizations"),
    projectId: v.id("projects"),
    watchId: v.id("watches"),
    result: v.union(v.literal("ok"), v.literal("stale"), v.literal("error"), v.literal("unknown")),
  },
  returns: v.union(v.object({ ok: v.literal(true) }), denialValidator),
  handler: async (ctx, args) => {
    const access = await requireDomainAccess(
      ctx,
      args.organizationId,
      args.projectId,
      "contributor",
    );
    if (!access.ok) {
      return { ok: false as const, code: access.code, message: access.message };
    }
    const watch = await requireOwnedRef(
      await ctx.db.get(args.watchId),
      args.organizationId,
      args.projectId,
    );
    if (!watch.ok) {
      return { ok: false as const, code: watch.code, message: watch.message };
    }
    if (watch.value.source !== "ownerImport") {
      return { ok: false as const, code: "invalid-payload", message: "internal watches check through the pipeline" };
    }
    const now = Date.now();
    await ctx.db.patch(args.watchId, {
      lastResult: args.result,
      lastCheckedAt: now,
      nextCheckAt: now + watch.value.cadenceMs,
    });
    return { ok: true as const };
  },
});

/**
 * Internal pipeline watch check (R1/C1 ingestion only): stamps an
 * internal verification result and advances the next check time. No
 * client can reach this path.
 */
export const ingestWatchCheck = f1InternalMutation({
  args: {
    watchId: v.id("watches"),
    result: v.union(v.literal("ok"), v.literal("stale"), v.literal("error"), v.literal("unknown")),
  },
  returns: v.union(v.object({ ok: v.literal(true) }), denialValidator),
  handler: async (ctx, args) => {
    const watch = await ctx.db.get(args.watchId);
    if (watch === null) {
      return { ok: false as const, code: "denied-membership", message: "unknown watch" };
    }
    const now = Date.now();
    await ctx.db.patch(args.watchId, {
      lastResult: args.result,
      lastCheckedAt: now,
      nextCheckAt: now + watch.cadenceMs,
      source: "internal",
    });
    return { ok: true as const };
  },
});

/** Append a material project event (append-only; no edits, no deletes). */
export const appendProjectEvent = f1Mutation({
  args: projectEventInputValidator.fields,
  returns: v.union(
    v.object({ ok: v.literal(true), eventId: v.id("projectEvents") }),
    denialValidator,
  ),
  handler: async (ctx, args) => {
    const access = await requireDomainAccess(
      ctx,
      args.organizationId,
      args.projectId,
      "contributor",
    );
    if (!access.ok) {
      return { ok: false as const, code: access.code, message: access.message };
    }
    if (args.kind.trim().length === 0) {
      return { ok: false as const, code: "invalid-payload", message: "event kind required" };
    }
    const eventId = await ctx.db.insert("projectEvents", {
      organizationId: args.organizationId,
      projectId: args.projectId,
      kind: args.kind,
      actor: access.value.identity,
      ...(args.evidenceRefs === undefined ? {} : { evidenceRefs: [...args.evidenceRefs] }),
      createdAt: Date.now(),
    });
    return { ok: true as const, eventId };
  },
});

/** List project events, newest first (bounded timeline read). */
export const listProjectEvents = f1Query({
  args: {
    organizationId: v.id("organizations"),
    projectId: v.id("projects"),
    limit: v.number(),
  },
  returns: v.union(
    v.object({
      ok: v.literal(true),
      events: v.array(v.object({ id: v.id("projectEvents"), kind: v.string() })),
    }),
    denialValidator,
  ),
  handler: async (ctx, args) => {
    const access = await requireDomainAccess(
      ctx,
      args.organizationId,
      args.projectId,
      "viewer",
    );
    if (!access.ok) {
      return { ok: false as const, code: access.code, message: access.message };
    }
    const rows = await ctx.db
      .query("projectEvents")
      .withIndex("by_project", (q) => q.eq("projectId", args.projectId))
      .order("desc")
      .take(Math.max(1, Math.min(50, Math.floor(args.limit))));
    return {
      ok: true as const,
      events: rows
        .filter((row) => row.organizationId === args.organizationId)
        .map((row) => ({ id: row._id, kind: row.kind })),
    };
  },
});

/**
 * Raise a risk with severity, source, owner, and optional dependency
 * references. Every referenced dependency must resolve in-project, so a
 * risk can never point at another workspace's graph.
 */
export const raiseRisk = f1Mutation({
  args: riskInputValidator.fields,
  returns: v.union(
    v.object({ ok: v.literal(true), riskId: v.id("risks") }),
    denialValidator,
  ),
  handler: async (ctx, args) => {
    const access = await requireDomainAccess(
      ctx,
      args.organizationId,
      args.projectId,
      "contributor",
    );
    if (!access.ok) {
      return { ok: false as const, code: access.code, message: access.message };
    }
    if (args.scope.trim().length === 0 || args.source.trim().length === 0) {
      return { ok: false as const, code: "invalid-payload", message: "scope and source required" };
    }
    for (const dependencyId of args.dependencyIds ?? []) {
      const dependency = await ctx.db.get(dependencyId);
      if (
        dependency === null ||
        dependency.organizationId !== args.organizationId ||
        dependency.projectId !== args.projectId
      ) {
        return { ok: false as const, code: "denied-project", message: "dependency is not in this project" };
      }
    }
    const now = Date.now();
    const riskId = await ctx.db.insert("risks", {
      organizationId: args.organizationId,
      projectId: args.projectId,
      scope: args.scope,
      severity: args.severity,
      state: "open",
      source: args.source,
      ...(args.owner === undefined ? {} : { owner: args.owner }),
      dependencyIds: [...(args.dependencyIds ?? [])],
      createdAt: now,
      updatedAt: now,
    });
    return { ok: true as const, riskId };
  },
});

/**
 * Move a risk through its resolution lifecycle (forward only).
 * Terminally accepting a risk requires approver authority or above and
 * records the accepting identity with its timestamp: a contributor
 * alone can mitigate or resolve, but never accept, a risk.
 */
export const resolveRisk = f1Mutation({
  args: {
    organizationId: v.id("organizations"),
    projectId: v.id("projects"),
    riskId: v.id("risks"),
    state: v.union(
      v.literal("open"),
      v.literal("mitigating"),
      v.literal("resolved"),
      v.literal("accepted"),
    ),
  },
  returns: v.union(v.object({ ok: v.literal(true) }), denialValidator),
  handler: async (ctx, args) => {
    const minRole = args.state === "accepted" ? "approver" : "contributor";
    const access = await requireDomainAccess(
      ctx,
      args.organizationId,
      args.projectId,
      minRole,
    );
    if (!access.ok) {
      return { ok: false as const, code: access.code, message: access.message };
    }
    const risk = await requireOwnedRef(
      await ctx.db.get(args.riskId),
      args.organizationId,
      args.projectId,
    );
    if (!risk.ok) {
      return { ok: false as const, code: risk.code, message: risk.message };
    }
    const order = ["open", "mitigating", "resolved", "accepted"] as const;
    const fromIndex = order.indexOf(risk.value.state);
    const toIndex = order.indexOf(args.state);
    if (toIndex < fromIndex) {
      return { ok: false as const, code: "invalid-payload", message: "risks move forward only" };
    }
    const now = Date.now();
    await ctx.db.patch(args.riskId, {
      state: args.state,
      updatedAt: now,
      ...(args.state === "accepted"
        ? { acceptedBy: access.value.identity, decidedAt: now }
        : {}),
    });
    return { ok: true as const };
  },
});

/**
 * Save a reusable template. Templates are organization-owned: the version
 * is unique per organization and the source project is kept as a
 * derivable parent reference. The saver proves contributor access in the
 * source project. Snapshots are canonical strings so reuse never depends
 * on live row identity.
 */
export const saveTemplate = f1Mutation({
  args: templateInputValidator.fields,
  returns: v.union(
    v.object({ ok: v.literal(true), templateId: v.id("templates"), deduplicated: v.boolean() }),
    denialValidator,
  ),
  handler: async (ctx, args) => {
    const access = await requireDomainAccess(
      ctx,
      args.organizationId,
      args.sourceProjectId,
      "contributor",
    );
    if (!access.ok) {
      return { ok: false as const, code: access.code, message: access.message };
    }
    if (args.name.trim().length === 0 || args.version.trim().length === 0) {
      return { ok: false as const, code: "invalid-payload", message: "name and version required" };
    }
    // Snapshots must parse before the version is claimed, so a broken
    // template can never occupy its version slot.
    if (
      parseSnapshotRequirements(args.requirementSnapshot) === null ||
      parseSnapshotConstraints(args.constraintSnapshot) === null
    ) {
      return { ok: false as const, code: "invalid-payload", message: "template snapshot is invalid" };
    }
    const duplicate = await ctx.db
      .query("templates")
      .withIndex("by_organization_and_version", (q) =>
        q.eq("organizationId", args.organizationId).eq("version", args.version),
      )
      .unique();
    if (duplicate !== null) {
      // Exact replay returns the stored row; any divergent field is a
      // version collision, never a silent overwrite.
      if (
        duplicate.sourceProjectId !== args.sourceProjectId ||
        duplicate.name !== args.name ||
        duplicate.requirementSnapshot !== args.requirementSnapshot ||
        duplicate.constraintSnapshot !== args.constraintSnapshot
      ) {
        return { ok: false as const, code: "duplicate-conflict", message: "template version already used with different fields" };
      }
      return { ok: true as const, templateId: duplicate._id, deduplicated: true };
    }
    const templateId = await ctx.db.insert("templates", {
      organizationId: args.organizationId,
      sourceProjectId: args.sourceProjectId,
      name: args.name,
      version: args.version,
      requirementSnapshot: args.requirementSnapshot,
      constraintSnapshot: args.constraintSnapshot,
      createdAt: Date.now(),
    });
    return { ok: true as const, templateId, deduplicated: false };
  },
});

interface SnapshotRequirement {
  readonly key: string;
  readonly title: string;
  readonly category: string;
  readonly quantity: string;
  readonly unit: string;
}

interface SnapshotConstraint {
  readonly fromKey: string;
  readonly toKey: string;
  readonly kind: "technical" | "scheduling";
}

// -- P-19 second-location reuse summary --------------------------------------

/**
 * Specification facts a template instantiation copies verbatim. They stay
 * reusable because they describe WHAT the target project needs, never any
 * supplier's current commercial terms.
 */
export const COPIED_SPECIFICATION_FIELDS = [
  "key",
  "title",
  "category",
  "quantity",
  "unit",
] as const;

/**
 * Current commercial or operational facts that a second location must
 * re-verify. Instantiation copies none of them and never marks any of
 * them checked: a truthful summary states `revalidationRequired` with
 * `checked: false`, never a stale claim about evidence that was not
 * copied.
 */
const REUSE_CURRENT_FACTS = [
  "price",
  "availabilityOrLeadTime",
  "warrantyOrServiceCoverage",
  "installationOrSiteCompatibility",
  "supplierTerms",
] as const;

const reuseCurrentFactCheckValidator = v.object({
  fact: v.string(),
  state: v.literal("revalidationRequired"),
  checked: v.literal(false),
  reason: v.string(),
});

const reuseSummaryValidator = v.object({
  templateId: v.id("templates"),
  templateVersion: v.string(),
  targetProjectId: v.id("projects"),
  copiedSpecificationFields: v.array(v.string()),
  currentFactChecks: v.array(reuseCurrentFactCheckValidator),
});

export const reuseSummaryFieldsValidator = reuseSummaryValidator.fields;

interface ReuseSummary {
  readonly templateId: Id<"templates">;
  readonly templateVersion: string;
  readonly targetProjectId: Id<"projects">;
  readonly copiedSpecificationFields: string[];
  readonly currentFactChecks: {
    readonly fact: string;
    readonly state: "revalidationRequired";
    readonly checked: false;
    readonly reason: string;
  }[];
}

/**
 * Derive the truthful reuse summary for one template instantiating into
 * one target project. The summary is a pure function of the template
 * identity/version and the target project, so an identical instantiation
 * replay returns exactly the same summary without any write.
 */
function reuseSummaryFor(
  templateId: Id<"templates">,
  templateVersion: string,
  targetProjectId: Id<"projects">,
): ReuseSummary {
  return {
    templateId,
    templateVersion,
    targetProjectId,
    copiedSpecificationFields: [...COPIED_SPECIFICATION_FIELDS],
    currentFactChecks: REUSE_CURRENT_FACTS.map((fact) => ({
      fact,
      state: "revalidationRequired" as const,
      checked: false as const,
      reason: `${fact} is a current commercial or operational fact; template version ${templateVersion} copied specifications only, so target project ${targetProjectId} requires a fresh check and none has been performed`,
    })),
  };
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function parseSnapshotRequirements(snapshot: string): SnapshotRequirement[] | null {
  let parsed: unknown;
  try {
    parsed = JSON.parse(snapshot);
  } catch {
    return null;
  }
  if (!Array.isArray(parsed)) return null;
  const out: SnapshotRequirement[] = [];
  for (const entry of parsed) {
    if (!isRecord(entry)) return null;
    const { key, title, category, quantity: rawQuantity, unit } = entry;
    if (
      typeof key !== "string" ||
      typeof title !== "string" ||
      typeof category !== "string" ||
      typeof rawQuantity !== "string" ||
      typeof unit !== "string"
    ) {
      return null;
    }
    // F1R-09: snapshot quantities validate through the accepted
    // proofs/money contract at parse time, so a broken template can
    // never occupy its version slot or instantiate partial rows.
    try {
      const parsedQuantity = quantity(rawQuantity);
      if (decimalCompare(parsedQuantity, decimalZero()) <= 0) return null;
    } catch {
      return null;
    }
    out.push({ key, title, category, quantity: rawQuantity, unit });
  }
  return out;
}

function parseSnapshotConstraints(snapshot: string): SnapshotConstraint[] | null {
  let parsed: unknown;
  try {
    parsed = JSON.parse(snapshot);
  } catch {
    return null;
  }
  if (!Array.isArray(parsed)) return null;
  const out: SnapshotConstraint[] = [];
  for (const entry of parsed) {
    if (!isRecord(entry)) return null;
    const { fromKey, toKey, kind } = entry;
    if (typeof fromKey !== "string" || typeof toKey !== "string") return null;
    if (kind !== "technical" && kind !== "scheduling") return null;
    out.push({ fromKey, toKey, kind });
  }
  return out;
}

/**
 * Instantiate a template into a target project. Only the whitelisted
 * reuse collections (requirements, constraints) are copied; the handler
 * holds no reference to orders, order events, or cost entries, so
 * historical commitments and cash provably stay behind. The template
 * must belong to the caller's organization.
 *
 * Every structural check runs before the first write: duplicate
 * snapshot keys, unknown edge endpoints, self edges, dependency cycles,
 * and bound overruns are all denied whole, so a failed instantiation
 * leaves zero partial rows. Replaying an already-instantiated template
 * returns the stored requirement rows instead of duplicating them.
 *
 * P-19: the result carries a truthful reuse summary derived from the
 * re-read template version and the target project — the copied
 * specification fields plus the five current-fact rechecks (price,
 * availability or lead time, warranty or service coverage, installation
 * or site compatibility, supplier terms), each explicitly
 * `revalidationRequired`/not checked. Template and target access are
 * re-read at the start of the handler, before any replay decision or
 * write.
 */
export const instantiateTemplate = f1Mutation({
  args: {
    organizationId: v.id("organizations"),
    targetProjectId: v.id("projects"),
    templateId: v.id("templates"),
  },
  returns: v.union(
    v.object({
      ok: v.literal(true),
      requirementIds: v.array(v.id("requirements")),
      collections: v.array(v.string()),
      deduplicated: v.boolean(),
      reuse: reuseSummaryValidator,
    }),
    denialValidator,
  ),
  handler: async (ctx, args) => {
    const access = await requireDomainAccess(
      ctx,
      args.organizationId,
      args.targetProjectId,
      "contributor",
    );
    if (!access.ok) {
      return { ok: false as const, code: access.code, message: access.message };
    }
    const template = await ctx.db.get(args.templateId);
    if (template === null || template.organizationId !== args.organizationId) {
      return { ok: false as const, code: "denied-project", message: "template is not in this organization" };
    }
    // P-19: second-location reuse targets a distinct project. The source
    // project already holds its own live graph, so instantiating into it
    // is denied before any replay lookup or write.
    if (template.sourceProjectId === args.targetProjectId) {
      return { ok: false as const, code: "invalid-payload", message: "template cannot instantiate into its own source project" };
    }
    const wanted = parseSnapshotRequirements(template.requirementSnapshot);
    const edges = parseSnapshotConstraints(template.constraintSnapshot);
    if (wanted === null || edges === null) {
      return { ok: false as const, code: "invalid-payload", message: "template snapshot is invalid" };
    }
    // Explicit instantiation bounds, validated before any write:
    // oversized snapshots are denied whole, never silently truncated.
    if (wanted.length === 0 || wanted.length > 50) {
      return { ok: false as const, code: "invalid-payload", message: "template requirement snapshot outside instantiation bound" };
    }
    if (edges.length > 100) {
      return { ok: false as const, code: "invalid-payload", message: "template constraint snapshot outside instantiation bound" };
    }
    if (!templateReuseExcludesHistoricFinancials([...TEMPLATE_REUSE_COLLECTIONS])) {
      return { ok: false as const, code: "invalid-payload", message: "reuse scope includes financials" };
    }
    // Snapshot-internal validation before any write: unique keys,
    // proofs/money quantities (positive, supported precision), known
    // endpoints, no self edges, no cycles. Any failure denies whole,
    // leaving zero partial requirements or dependencies.
    const seenKeys = new Set<string>();
    const normalizedQuantities = new Map<string, string>();
    for (const item of wanted) {
      if (seenKeys.has(item.key)) {
        return { ok: false as const, code: "invalid-payload", message: `duplicate requirement key ${item.key}` };
      }
      seenKeys.add(item.key);
      // Defense in depth: templates stored before F1R-09 hardening
      // re-validate here, before the first write.
      try {
        const parsedQuantity = quantity(item.quantity);
        if (decimalCompare(parsedQuantity, decimalZero()) <= 0) {
          return { ok: false as const, code: "invalid-payload", message: "template requirement quantity must be positive" };
        }
        normalizedQuantities.set(item.key, decimalToString(parsedQuantity));
      } catch {
        return { ok: false as const, code: "invalid-payload", message: "template requirement quantity is not a valid decimal" };
      }
    }
    const edgeShapes: { from: string; to: string }[] = [];
    for (const edge of edges) {
      if (!seenKeys.has(edge.fromKey) || !seenKeys.has(edge.toKey)) {
        return { ok: false as const, code: "invalid-payload", message: "dependency endpoint is not in the snapshot" };
      }
      if (edge.fromKey === edge.toKey) {
        return { ok: false as const, code: "invalid-payload", message: "dependency self edge is not allowed" };
      }
      if (dependencyCreatesCycle(edgeShapes, edge.fromKey, edge.toKey)) {
        return { ok: false as const, code: "invalid-payload", message: "dependency would create a cycle" };
      }
      edgeShapes.push({ from: edge.fromKey, to: edge.toKey });
    }
    // Target-side pre-check before any write: exact replay returns the
    // stored rows, any foreign key occupancy conflicts whole.
    const idsByKey = new Map<string, Id<"requirements">>();
    for (const item of wanted) {
      const duplicate = await ctx.db
        .query("requirements")
        .withIndex("by_project_and_key", (q) =>
          q.eq("projectId", args.targetProjectId).eq("key", item.key),
        )
        .unique();
      if (duplicate === null) continue;
      if (duplicate.organizationId !== args.organizationId) {
        return { ok: false as const, code: "denied-project", message: "reference is not in this project" };
      }
      idsByKey.set(item.key, duplicate._id);
    }
    if (idsByKey.size === wanted.length) {
      const replayed = wanted.map((item) => idsByKey.get(item.key));
      if (replayed.every((id): id is Id<"requirements"> => id !== undefined)) {
        const replayMatches = await Promise.all(
          replayed.map(async (id) => {
            const row = await ctx.db.get(id);
            return (
              row !== null &&
              row.templateId === args.templateId &&
              row.templateVersion === template.version
            );
          }),
        );
        if (replayMatches.every(Boolean)) {
          return {
            ok: true as const,
            requirementIds: replayed,
            collections: [...TEMPLATE_REUSE_COLLECTIONS],
            deduplicated: true,
            // Identical replay: the summary derives only from the re-read
            // template version and the target project, so it matches the
            // original instantiation byte for byte without any write.
            reuse: reuseSummaryFor(
              template._id,
              template.version,
              args.targetProjectId,
            ),
          };
        }
      }
      return { ok: false as const, code: "duplicate-conflict", message: "target project already holds these requirement keys" };
    }
    if (idsByKey.size > 0) {
      return { ok: false as const, code: "duplicate-conflict", message: "target project already holds some requirement keys" };
    }
    const now = Date.now();
    const requirementIds: Id<"requirements">[] = [];
    for (const item of wanted) {
      const normalizedQuantity = normalizedQuantities.get(item.key);
      if (normalizedQuantity === undefined) {
        throw new Error("instantiation invariant violated: validated quantity missing");
      }
      const requirementId = await ctx.db.insert("requirements", {
        organizationId: args.organizationId,
        projectId: args.targetProjectId,
        key: item.key,
        title: item.title,
        category: item.category,
        quantity: normalizedQuantity,
        unit: item.unit,
        priority: "P1",
        state: "draft",
        fulfillment: "notOrdered",
        version: 1,
        templateId: args.templateId,
        templateVersion: template.version,
        createdAt: now,
        updatedAt: now,
      });
      idsByKey.set(item.key, requirementId);
      requirementIds.push(requirementId);
    }
    for (const edge of edges) {
      const from = idsByKey.get(edge.fromKey);
      const to = idsByKey.get(edge.toKey);
      if (from === undefined || to === undefined) {
        throw new Error("instantiation invariant violated: validated endpoint missing");
      }
      await ctx.db.insert("dependencies", {
        organizationId: args.organizationId,
        projectId: args.targetProjectId,
        fromRequirementId: from,
        toRequirementId: to,
        kind: edge.kind,
        verification: "pending",
        createdAt: now,
      });
    }
    return {
      ok: true as const,
      requirementIds,
      collections: [...TEMPLATE_REUSE_COLLECTIONS],
      deduplicated: false,
      reuse: reuseSummaryFor(template._id, template.version, args.targetProjectId),
    };
  },
});

/**
 * P-19 second-location reuse revalidation state (bounded authorized read).
 *
 * Lists the template-reused requirements of one target project with a
 * truthful per-requirement summary: the copied specification facts with
 * their reused values (key, title, category, quantity, unit) and the five
 * current-fact rechecks (price, availability or lead time, warranty or
 * service coverage, installation or site compatibility, supplier terms),
 * each `revalidationRequired` with `checked: false` and a reason tied to
 * the template version and target project. No current commercial or
 * operational fact is asserted, no stale evidence is claimed, and no
 * source-project data is exposed: the read returns lineage as the
 * template id and version only.
 *
 * Cursor paging over the project index keeps every reused row reachable
 * no matter how many manually authored requirements precede it: each
 * call scans at most `limit` project rows (a positive safe integer up
 * to 200; anything else is denied) and returns every reused requirement
 * inside that scanned window. `complete` is
 * true only when the whole project has been scanned, so a page is never
 * mistaken for the exhaustive set; when `complete` is false, the caller
 * resumes from `continueCursor`, which continues exactly after the
 * scanned window so no row is skipped.
 */
export const listTemplateReuseRevalidation = f1Query({
  args: {
    organizationId: v.id("organizations"),
    projectId: v.id("projects"),
    limit: v.number(),
    cursor: v.optional(v.string()),
  },
  returns: v.union(
    v.object({
      ok: v.literal(true),
      complete: v.boolean(),
      continueCursor: v.optional(v.string()),
      scanned: v.number(),
      requirements: v.array(
        v.object({
          requirementId: v.id("requirements"),
          key: v.string(),
          title: v.string(),
          category: v.string(),
          quantity: v.string(),
          unit: v.string(),
          templateId: v.id("templates"),
          templateVersion: v.string(),
          copiedSpecificationFields: v.array(v.string()),
          currentFactChecks: v.array(reuseCurrentFactCheckValidator),
        }),
      ),
    }),
    denialValidator,
  ),
  handler: async (ctx, args) => {
    const access = await requireDomainAccess(
      ctx,
      args.organizationId,
      args.projectId,
      "viewer",
    );
    if (!access.ok) {
      return { ok: false as const, code: access.code, message: access.message };
    }
    // Fail closed on malformed bounds: only a positive safe integer
    // within the supported scan bound is accepted. Non-finite, fractional,
    // zero/negative, and over-max values are denied, never clamped.
    if (
      !Number.isSafeInteger(args.limit) ||
      args.limit <= 0 ||
      args.limit > 200
    ) {
      return { ok: false as const, code: "invalid-payload", message: "limit must be a positive safe integer within the supported scan bound of 200" };
    }
    // `limit` bounds the rows scanned and returned per page, not an
    // output cap beyond the scan: every reused requirement inside the
    // scanned window is returned, so truncating output could never
    // silently drop a reused row that the continuation cursor would
    // otherwise skip.
    const scanRows = args.limit;
    const page = await ctx.db
      .query("requirements")
      .withIndex("by_project", (q) => q.eq("projectId", args.projectId))
      .paginate({
        cursor: args.cursor ?? null,
        numItems: scanRows,
        maximumRowsRead: scanRows,
      });
    const reused = page.page.filter(
      (row): row is typeof row & { readonly templateId: Id<"templates"> } =>
        row.organizationId === args.organizationId && row.templateId !== undefined,
    );
    return {
      ok: true as const,
      complete: page.isDone,
      ...(page.isDone ? {} : { continueCursor: page.continueCursor }),
      scanned: page.page.length,
      requirements: reused.map((row) => ({
        requirementId: row._id,
        key: row.key,
        title: row.title,
        category: row.category,
        quantity: row.quantity,
        unit: row.unit,
        templateId: row.templateId,
        templateVersion: row.templateVersion ?? "unknown",
        copiedSpecificationFields: [...COPIED_SPECIFICATION_FIELDS],
        currentFactChecks: reuseSummaryFor(
          row.templateId,
          row.templateVersion ?? "unknown",
          args.projectId,
        ).currentFactChecks,
      })),
    };
  },
});
