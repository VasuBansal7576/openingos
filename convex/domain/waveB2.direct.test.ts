/// <reference types="vite/client" />
/**
 * Wave B2 regression tests for Astra review 2cd59ec (F1R-06, F1R-07, F1R-08).
 *
 * Controlled contract only: these tests run the ACTUAL exported domain
 * handlers against the REAL schema with authenticated identities via
 * official convex-test. No provider calls, mail, or external writes occur.
 *
 * - F1R-06: compatibility passes bind resolving, versioned, relevant
 *   evidence and pin requirement/rule versions; anything else denies and
 *   leaves the finding unknown; disputed evidence invalidates findings.
 * - F1R-07: evidence and watch replays compare the full material
 *   snapshot on public and internal paths; RFQ vendor sets compare
 *   normalized.
 * - F1R-08: quote successors retain their offer's requirement, vendor,
 *   RFQ, conversation, and counterparty lineage.
 */

import { convexTest } from "convex-test";
import { describe, expect, test } from "vitest";
import {
  makeFunctionReference,
  type RegisteredMutation,
} from "convex/server";
import type { Id } from "../_generated/dataModel.js";
import schema from "../schema.js";
import * as memberships from "../access/memberships.js";
import * as quotes from "../purchasing/contracts/quotes.js";
import * as requirements from "./requirements.js";
import * as sourcing from "./sourcing.js";
import * as workspace from "./workspace.js";

const rawModules = import.meta.glob([
  "../access/**/*.ts",
  "../execution/**/*.ts",
  "../purchasing/**/*.ts",
  "../shared/**/*.ts",
  "./**/*.ts",
  "../server.ts",
  "../auth.ts",
  "../models/**/*.ts",
  "../_generated/*.js",
  "!../access/**/*.test.ts",
  "!../execution/**/*.test.ts",
  "!../purchasing/**/*.test.ts",
  "!../shared/**/*.test.ts",
  "!./**/*.test.ts",
]);

const modules: Record<string, () => Promise<unknown>> = {};
for (const [path, loader] of Object.entries(rawModules)) {
  const relative = path.startsWith("./")
    ? `domain/${path.slice(2)}`
    : path.replace(/^(\.\.\/)+/, "");
  modules[relative] = loader as () => Promise<unknown>;
}

type MutationArgs<T> = T extends RegisteredMutation<infer _V, infer A, infer _R> ? A : never;
type MutationReturn<T> = T extends RegisteredMutation<infer _V, infer _A, infer R> ? R : never;

const createOrganizationRef = makeFunctionReference<
  "mutation",
  MutationArgs<typeof memberships.createOrganization>,
  MutationReturn<typeof memberships.createOrganization>
>("access/memberships:createOrganization");
const createProjectRef = makeFunctionReference<
  "mutation",
  MutationArgs<typeof memberships.createProject>,
  MutationReturn<typeof memberships.createProject>
>("access/memberships:createProject");
const createRequirementRef = makeFunctionReference<
  "mutation",
  MutationArgs<typeof requirements.create>,
  MutationReturn<typeof requirements.create>
>("domain/requirements:create");
const recordVendorRef = makeFunctionReference<
  "mutation",
  MutationArgs<typeof sourcing.recordVendor>,
  MutationReturn<typeof sourcing.recordVendor>
>("domain/sourcing:recordVendor");
const recordCandidateRef = makeFunctionReference<
  "mutation",
  MutationArgs<typeof sourcing.recordCandidate>,
  MutationReturn<typeof sourcing.recordCandidate>
>("domain/sourcing:recordCandidate");
const recordProductEvidenceRef = makeFunctionReference<
  "mutation",
  MutationArgs<typeof sourcing.recordProductEvidence>,
  MutationReturn<typeof sourcing.recordProductEvidence>
>("domain/sourcing:recordProductEvidence");
const ingestProductEvidenceRef = makeFunctionReference<
  "mutation",
  MutationArgs<typeof sourcing.ingestProductEvidence>,
  MutationReturn<typeof sourcing.ingestProductEvidence>
>("domain/sourcing:ingestProductEvidence");
const linkEvidenceConflictRef = makeFunctionReference<
  "mutation",
  MutationArgs<typeof sourcing.linkEvidenceConflict>,
  MutationReturn<typeof sourcing.linkEvidenceConflict>
>("domain/sourcing:linkEvidenceConflict");
const verifyProductEvidenceRef = makeFunctionReference<
  "mutation",
  MutationArgs<typeof sourcing.verifyProductEvidence>,
  MutationReturn<typeof sourcing.verifyProductEvidence>
>("domain/sourcing:verifyProductEvidence");
const verifyCompatibilityRef = makeFunctionReference<
  "mutation",
  MutationArgs<typeof sourcing.verifyCompatibility>,
  MutationReturn<typeof sourcing.verifyCompatibility>
>("domain/sourcing:verifyCompatibility");
const createRfqRef = makeFunctionReference<
  "mutation",
  MutationArgs<typeof sourcing.createRfq>,
  MutationReturn<typeof sourcing.createRfq>
>("domain/sourcing:createRfq");
const createWatchRef = makeFunctionReference<
  "mutation",
  MutationArgs<typeof workspace.createWatch>,
  MutationReturn<typeof workspace.createWatch>
>("domain/workspace:createWatch");
const recordQuoteRef = makeFunctionReference<
  "mutation",
  MutationArgs<typeof quotes.record>,
  MutationReturn<typeof quotes.record>
>("purchasing/contracts/quotes:record");

const OWNER = { tokenIdentifier: "wave-b2-owner" };

async function setupProject(t: ReturnType<typeof convexTest>, name: string) {
  const asOwner = t.withIdentity(OWNER);
  const org = await asOwner.mutation(createOrganizationRef, { name: `${name} org`, kind: "private" });
  if (!org.ok) throw new Error("org setup failed");
  const proj = await asOwner.mutation(createProjectRef, {
    organizationId: org.organizationId,
    name: `${name} project`,
    visibility: "open",
  });
  if (!proj.ok) throw new Error("project setup failed");
  return { orgId: org.organizationId, projectId: proj.projectId };
}

async function setupGraph(
  t: ReturnType<typeof convexTest>,
  project: { orgId: Id<"organizations">; projectId: Id<"projects"> },
  suffix: string,
) {
  const asOwner = t.withIdentity(OWNER);
  const requirement = await asOwner.mutation(createRequirementRef, {
    organizationId: project.orgId,
    projectId: project.projectId,
    key: `req-${suffix}`,
    title: `Machine ${suffix}`,
    category: "coffee",
    quantity: "1",
    unit: "piece",
    priority: "P0",
  });
  if (!requirement.ok) throw new Error("requirement setup failed");
  const vendor = await asOwner.mutation(recordVendorRef, {
    organizationId: project.orgId,
    name: `Vendor ${suffix}`,
    regions: ["NL"],
  });
  if (!vendor.ok) throw new Error("vendor setup failed");
  const candidate = await asOwner.mutation(recordCandidateRef, {
    organizationId: project.orgId,
    projectId: project.projectId,
    requirementId: requirement.requirementId,
    vendorId: vendor.vendorId,
    productModel: `Model ${suffix}`,
    variant: "220V",
    conversationState: "draft",
  });
  if (!candidate.ok) throw new Error("candidate setup failed");
  return { requirementId: requirement.requirementId, vendorId: vendor.vendorId, candidateId: candidate.candidateId };
}

async function recordFieldEvidence(
  t: ReturnType<typeof convexTest>,
  project: { orgId: Id<"organizations">; projectId: Id<"projects"> },
  refs: { requirementId?: Id<"requirements">; candidateId?: Id<"candidates"> },
  key: string,
  extra: { freshness?: "fresh" | "stale" | "expired" | "unknown"; sourceUrl?: string } = {},
) {
  return t.withIdentity(OWNER).mutation(recordProductEvidenceRef, {
    organizationId: project.orgId,
    projectId: project.projectId,
    ...(refs.requirementId === undefined ? {} : { requirementId: refs.requirementId }),
    ...(refs.candidateId === undefined ? {} : { candidateId: refs.candidateId }),
    field: "power",
    sourceKind: "manual",
    ...(extra.sourceUrl === undefined ? {} : { sourceUrl: extra.sourceUrl }),
    capturedAt: 1,
    originalValue: "220V",
    normalizedValue: "220V",
    freshness: extra.freshness ?? "fresh",
    counterpartyRole: "vendor",
    idempotencyKey: key,
  });
}

async function verify(
  t: ReturnType<typeof convexTest>,
  project: { orgId: Id<"organizations">; projectId: Id<"projects"> },
  candidateId: Id<"candidates">,
  refs: { sourceId: string; version: string }[],
) {
  return t.withIdentity(OWNER).mutation(verifyCompatibilityRef, {
    organizationId: project.orgId,
    projectId: project.projectId,
    candidateId,
    result: "pass",
    evidenceRefs: refs,
  });
}

/** Resolve field evidence to verified; returns the bumped exact version. */
async function resolveVerified(
  t: ReturnType<typeof convexTest>,
  project: { orgId: Id<"organizations">; projectId: Id<"projects"> },
  evidenceId: Id<"productEvidence">,
): Promise<string> {
  const resolved = await t.withIdentity(OWNER).mutation(verifyProductEvidenceRef, {
    organizationId: project.orgId,
    projectId: project.projectId,
    evidenceId,
    verdict: "verified",
  });
  if (!resolved.ok) throw new Error("evidence resolution failed");
  const row = await t.run((ctx) => ctx.db.get(evidenceId));
  if (row?.verification !== "verified") throw new Error("evidence not verified");
  return row.version;
}

function quoteArgs(
  project: { orgId: Id<"organizations">; projectId: Id<"projects"> },
  version: string,
  refs: {
    requirementId?: Id<"requirements">;
    vendorId?: Id<"vendors">;
    rfqId?: Id<"rfqs">;
    conversationId?: Id<"conversations">;
    supersedes?: string;
  } = {},
) {
  return {
    organizationId: project.orgId,
    projectId: project.projectId,
    version,
    currency: "EUR",
    lines: [{
      lineId: "machine",
      description: "machine",
      quantity: "1",
      unitPrice: { currency: "EUR", minorUnits: 795000 },
      evidenceRefs: [],
    }],
    charges: [],
    taxBasis: { kind: "inclusive" as const, basisId: "NL-EUR-INCLUSIVE", evidenceRefs: [] },
    comparisonScope: {
      requirementId: "req-wave-b2",
      scopeId: "scope-b2",
      items: [{ itemId: "machine", lineId: "machine", unit: "piece", requiredQuantity: "1" }],
    },
    evidenceRefs: [],
    ...(refs.requirementId === undefined ? {} : { requirementId: refs.requirementId }),
    ...(refs.vendorId === undefined ? {} : { vendorId: refs.vendorId }),
    ...(refs.rfqId === undefined ? {} : { rfqId: refs.rfqId }),
    ...(refs.conversationId === undefined ? {} : { conversationId: refs.conversationId }),
    ...(refs.supersedes === undefined ? {} : { supersedes: refs.supersedes }),
  };
}

describe("F1R-06 compatibility binds resolving versioned evidence", () => {
  test("nonexistent evidence is denied and the finding stays unknown", async () => {
    const t = convexTest(schema, modules);
    const project = await setupProject(t, "compat-missing");
    const graph = await setupGraph(t, project, "main");
    const denied = await verify(t, project, graph.candidateId, [
      { sourceId: "nonexistent-evidence", version: "1" },
    ]);
    expect(denied.ok).toBe(false);
    const row = await t.run((ctx) => ctx.db.get(graph.candidateId));
    expect(row?.compatibility).toBe("unknown");
  });

  test("foreign evidence is denied", async () => {
    const t = convexTest(schema, modules);
    const projectA = await setupProject(t, "compat-foreign-a");
    const graphA = await setupGraph(t, projectA, "a");
    const projectB = await setupProject(t, "compat-foreign-b");
    const graphB = await setupGraph(t, projectB, "b");
    const foreign = await recordFieldEvidence(t, projectB, graphB, "ev-foreign");
    if (!foreign.ok) throw new Error("foreign evidence setup failed");
    const denied = await verify(t, projectA, graphA.candidateId, [
      { sourceId: foreign.evidenceId, version: "1" },
    ]);
    expect(denied.ok).toBe(false);
  });

  test("stale-version and non-fresh evidence are denied", async () => {
    const t = convexTest(schema, modules);
    const project = await setupProject(t, "compat-stale");
    const graph = await setupGraph(t, project, "main");
    const evidence = await recordFieldEvidence(t, project, graph, "ev-stale");
    if (!evidence.ok) throw new Error("evidence setup failed");
    const wrongVersion = await verify(t, project, graph.candidateId, [
      { sourceId: evidence.evidenceId, version: "0" },
    ]);
    expect(wrongVersion.ok).toBe(false);
    const tired = await recordFieldEvidence(t, project, graph, "ev-tired", { freshness: "stale" });
    if (!tired.ok) throw new Error("stale evidence setup failed");
    const nonFresh = await verify(t, project, graph.candidateId, [
      { sourceId: tired.evidenceId, version: "1" },
    ]);
    expect(nonFresh.ok).toBe(false);
    const row = await t.run((ctx) => ctx.db.get(graph.candidateId));
    expect(row?.compatibility).toBe("unknown");
  });

  test("unrelated requirement and variant evidence are denied", async () => {
    const t = convexTest(schema, modules);
    const project = await setupProject(t, "compat-unrelated");
    const left = await setupGraph(t, project, "left");
    const right = await setupGraph(t, project, "right");
    const otherVariant = await recordFieldEvidence(t, project, right, "ev-other-variant");
    if (!otherVariant.ok) throw new Error("evidence setup failed");
    const crossVariant = await verify(t, project, left.candidateId, [
      { sourceId: otherVariant.evidenceId, version: "1" },
    ]);
    expect(crossVariant.ok).toBe(false);
    const otherRequirement = await recordFieldEvidence(
      t,
      project,
      { requirementId: right.requirementId },
      "ev-other-requirement",
    );
    if (!otherRequirement.ok) throw new Error("evidence setup failed");
    const crossRequirement = await verify(t, project, left.candidateId, [
      { sourceId: otherRequirement.evidenceId, version: "1" },
    ]);
    expect(crossRequirement.ok).toBe(false);
  });

  test("valid verified evidence passes and pins requirement and rule versions", async () => {
    const t = convexTest(schema, modules);
    const project = await setupProject(t, "compat-valid");
    const graph = await setupGraph(t, project, "main");
    const evidence = await recordFieldEvidence(t, project, graph, "ev-valid");
    if (!evidence.ok) throw new Error("evidence setup failed");
    const version = await resolveVerified(t, project, evidence.evidenceId);
    const passed = await verify(t, project, graph.candidateId, [
      { sourceId: evidence.evidenceId, version },
    ]);
    expect(passed.ok).toBe(true);
    const row = await t.run((ctx) => ctx.db.get(graph.candidateId));
    expect(row?.compatibility).toBe("pass");
    expect(row?.compatibilityRequirementVersion).toBe(1);
    expect(row?.compatibilityRuleVersion).toBe("1");
  });

  test("unverified evidence is denied and the finding stays unknown", async () => {
    const t = convexTest(schema, modules);
    const project = await setupProject(t, "compat-unverified");
    const graph = await setupGraph(t, project, "main");
    const evidence = await recordFieldEvidence(t, project, graph, "ev-raw");
    if (!evidence.ok) throw new Error("evidence setup failed");
    const denied = await verify(t, project, graph.candidateId, [
      { sourceId: evidence.evidenceId, version: "1" },
    ]);
    expect(denied.ok).toBe(false);
    if (!denied.ok) expect(denied.code).toBe("unverified-evidence");
    const row = await t.run((ctx) => ctx.db.get(graph.candidateId));
    expect(row?.compatibility).toBe("unknown");
  });

  test("disputed evidence is denied and invalidates the decided finding", async () => {
    const t = convexTest(schema, modules);
    const project = await setupProject(t, "compat-dispute");
    const asOwner = t.withIdentity(OWNER);
    const graph = await setupGraph(t, project, "main");
    const evidence = await recordFieldEvidence(t, project, graph, "ev-disputed");
    if (!evidence.ok) throw new Error("evidence setup failed");
    const version = await resolveVerified(t, project, evidence.evidenceId);
    const passed = await verify(t, project, graph.candidateId, [
      { sourceId: evidence.evidenceId, version },
    ]);
    expect(passed.ok).toBe(true);
    const rival = await recordFieldEvidence(t, project, graph, "ev-rival");
    if (!rival.ok) throw new Error("rival evidence setup failed");
    const disputed = await asOwner.mutation(linkEvidenceConflictRef, {
      organizationId: project.orgId,
      projectId: project.projectId,
      evidenceId: evidence.evidenceId,
      conflictingIds: [rival.evidenceId],
    });
    expect(disputed.ok).toBe(true);
    // The decided finding returns to unknown with its basis pins cleared.
    const reset = await t.run((ctx) => ctx.db.get(graph.candidateId));
    expect(reset?.compatibility).toBe("unknown");
    expect(reset?.compatibilityEvidenceRefs).toHaveLength(0);
    // Both the pre-resolution revision and the disputed row are unusable.
    const oldRevision = await verify(t, project, graph.candidateId, [
      { sourceId: evidence.evidenceId, version },
    ]);
    expect(oldRevision.ok).toBe(false);
    const disputedRow = await t.run((ctx) => ctx.db.get(evidence.evidenceId));
    const rebased = await verify(t, project, graph.candidateId, [
      { sourceId: evidence.evidenceId, version: disputedRow?.version ?? "missing" },
    ]);
    expect(rebased.ok).toBe(false);
    if (!rebased.ok) expect(rebased.code).toBe("conflicted-evidence");
  });

  test.each([49, 50, 51, 125])("conflict invalidates every dependent candidate at %i rows and preserves unrelated findings", async (count) => {
    const t = convexTest(schema, modules);
    const project = await setupProject(t, `compat-many-${count}`);
    const asOwner = t.withIdentity(OWNER);
    const graph = await setupGraph(t, project, `many-${count}`);
    const shared = await recordFieldEvidence(t, project, { requirementId: graph.requirementId }, `compat-many-evidence-${count}`);
    if (!shared.ok) throw new Error("shared evidence setup failed");
    const version = await resolveVerified(t, project, shared.evidenceId);
    const addCandidate = async (index: number) => {
      const created = await asOwner.mutation(recordCandidateRef, {
        organizationId: project.orgId,
        projectId: project.projectId,
        requirementId: graph.requirementId,
        vendorId: graph.vendorId,
        productModel: `Model many-${count}-${index}`,
        variant: "220V",
        conversationState: "draft",
      });
      if (!created.ok) throw new Error("candidate setup failed");
      return created.candidateId;
    };
    const candidateIds: Id<"candidates">[] = [graph.candidateId];
    for (let index = 1; index < count; index += 1) candidateIds.push(await addCandidate(index));
    for (const candidateId of candidateIds) {
      const verified = await verify(t, project, candidateId, [{ sourceId: shared.evidenceId, version }]);
      expect(verified.ok).toBe(true);
    }

    const unrelatedGraph = await setupGraph(t, project, `many-unrelated-${count}`);
    const unrelatedEvidence = await recordFieldEvidence(
      t,
      project,
      { requirementId: unrelatedGraph.requirementId },
      `compat-many-unrelated-${count}`,
    );
    if (!unrelatedEvidence.ok) throw new Error("unrelated evidence setup failed");
    const unrelatedVersion = await resolveVerified(t, project, unrelatedEvidence.evidenceId);
    const unrelatedVerified = await verify(t, project, unrelatedGraph.candidateId, [
      { sourceId: unrelatedEvidence.evidenceId, version: unrelatedVersion },
    ]);
    expect(unrelatedVerified.ok).toBe(true);

    const conflicting = await recordFieldEvidence(t, project, { requirementId: graph.requirementId }, `compat-many-conflict-${count}`);
    if (!conflicting.ok) throw new Error("conflicting evidence setup failed");
    const disputed = await asOwner.mutation(linkEvidenceConflictRef, {
      organizationId: project.orgId,
      projectId: project.projectId,
      evidenceId: shared.evidenceId,
      conflictingIds: [conflicting.evidenceId],
    });
    expect(disputed.ok).toBe(true);

    const affected = await t.run((ctx) =>
      ctx.db
        .query("candidates")
        .withIndex("by_requirement", (q) => q.eq("requirementId", graph.requirementId))
        .collect(),
    );
    expect(affected.filter((row) => row.compatibility === "pass")).toHaveLength(0);
    const unrelated = await t.run((ctx) => ctx.db.get(unrelatedGraph.candidateId));
    expect(unrelated?.compatibility).toBe("pass");
  });

  test("sparse indexed references remain resolvable beyond the candidate fanout bound", async () => {
    const t = convexTest(schema, modules);
    const project = await setupProject(t, "compat-sparse-over-bound");
    const asOwner = t.withIdentity(OWNER);
    const graph = await setupGraph(t, project, "sparse-over-bound");
    const shared = await recordFieldEvidence(
      t,
      project,
      { requirementId: graph.requirementId },
      "compat-sparse-shared",
    );
    if (!shared.ok) throw new Error("shared evidence setup failed");
    const sharedVersion = await resolveVerified(t, project, shared.evidenceId);
    const candidateIds: Id<"candidates">[] = [graph.candidateId];
    for (let index = 1; index <= sourcing.MAX_COMPATIBILITY_FANOUT; index += 1) {
      const created = await asOwner.mutation(recordCandidateRef, {
        organizationId: project.orgId,
        projectId: project.projectId,
        requirementId: graph.requirementId,
        vendorId: graph.vendorId,
        productModel: `Model sparse-over-bound-${index}`,
        variant: "220V",
        conversationState: "draft",
      });
      if (!created.ok) throw new Error("candidate setup failed");
      candidateIds.push(created.candidateId);
    }
    const tailCandidateId = candidateIds[candidateIds.length - 1];
    if (tailCandidateId === undefined) throw new Error("tail candidate missing");
    const specific = await recordFieldEvidence(
      t,
      project,
      { candidateId: tailCandidateId },
      "compat-sparse-specific",
    );
    if (!specific.ok) throw new Error("candidate evidence setup failed");
    const specificVersion = await resolveVerified(t, project, specific.evidenceId);

    expect((await verify(t, project, graph.candidateId, [
      { sourceId: shared.evidenceId, version: sharedVersion },
    ])).ok).toBe(true);
    expect((await verify(t, project, tailCandidateId, [
      { sourceId: shared.evidenceId, version: sharedVersion },
      { sourceId: specific.evidenceId, version: specificVersion },
    ])).ok).toBe(true);

    const indexed = await t.run((ctx) =>
      ctx.db
        .query("compatibilityEvidenceBindings")
        .withIndex("by_evidence", (q) => q.eq("evidenceId", shared.evidenceId))
        .take(sourcing.MAX_COMPATIBILITY_FANOUT + 1),
    );
    expect(indexed).toHaveLength(2);
    const conflicting = await recordFieldEvidence(
      t,
      project,
      { requirementId: graph.requirementId },
      "compat-sparse-conflict",
    );
    if (!conflicting.ok) throw new Error("conflicting evidence setup failed");
    const disputed = await asOwner.mutation(linkEvidenceConflictRef, {
      organizationId: project.orgId,
      projectId: project.projectId,
      evidenceId: shared.evidenceId,
      conflictingIds: [conflicting.evidenceId],
    });
    expect(disputed.ok).toBe(true);
    expect((await t.run((ctx) => ctx.db.get(graph.candidateId)))?.compatibility).toBe("unknown");
    expect((await t.run((ctx) => ctx.db.get(tailCandidateId)))?.compatibility).toBe("unknown");

    // The candidate-specific index remains independently addressable after
    // the shared requirement evidence has been disputed.
    expect((await verify(t, project, tailCandidateId, [
      { sourceId: specific.evidenceId, version: specificVersion },
    ])).ok).toBe(true);
    const specificConflict = await recordFieldEvidence(
      t,
      project,
      { candidateId: tailCandidateId },
      "compat-sparse-specific-conflict",
    );
    if (!specificConflict.ok) throw new Error("specific conflict setup failed");
    const specificDisputed = await asOwner.mutation(linkEvidenceConflictRef, {
      organizationId: project.orgId,
      projectId: project.projectId,
      evidenceId: specific.evidenceId,
      conflictingIds: [specificConflict.evidenceId],
    });
    expect(specificDisputed.ok).toBe(true);
    expect((await t.run((ctx) => ctx.db.get(tailCandidateId)))?.compatibility).toBe("unknown");
  });

  test("fanout above the integrity bound is denied before evidence or pass rows change", async () => {
    const t = convexTest(schema, modules);
    const project = await setupProject(t, "compat-fanout-boundary");
    const asOwner = t.withIdentity(OWNER);
    const graph = await setupGraph(t, project, "fanout-boundary");
    const shared = await recordFieldEvidence(t, project, { requirementId: graph.requirementId }, "compat-fanout-boundary-evidence");
    if (!shared.ok) throw new Error("shared evidence setup failed");
    const version = await resolveVerified(t, project, shared.evidenceId);
    const count = sourcing.MAX_COMPATIBILITY_FANOUT + 1;
    for (let index = 1; index < count; index += 1) {
      const created = await asOwner.mutation(recordCandidateRef, {
        organizationId: project.orgId,
        projectId: project.projectId,
        requirementId: graph.requirementId,
        vendorId: graph.vendorId,
        productModel: `Model fanout-boundary-${index}`,
        variant: "220V",
        conversationState: "draft",
      });
      if (!created.ok) throw new Error("candidate setup failed");
    }
    await t.run(async (ctx) => {
      const candidates = await ctx.db
        .query("candidates")
        .withIndex("by_requirement", (q) => q.eq("requirementId", graph.requirementId))
        .take(count);
      expect(candidates).toHaveLength(count);
      for (const candidate of candidates) {
        await ctx.db.patch(candidate._id, {
          compatibility: "pass",
          compatibilityEvidenceRefs: [{ sourceId: shared.evidenceId, version }],
        });
      }
    });
    const beforeEvidence = await t.run((ctx) => ctx.db.get(shared.evidenceId));
    const conflicting = await recordFieldEvidence(t, project, { requirementId: graph.requirementId }, "compat-fanout-boundary-conflict");
    if (!conflicting.ok) throw new Error("conflicting evidence setup failed");
    const denied = await asOwner.mutation(linkEvidenceConflictRef, {
      organizationId: project.orgId,
      projectId: project.projectId,
      evidenceId: shared.evidenceId,
      conflictingIds: [conflicting.evidenceId],
    });
    expect(denied.ok).toBe(false);
    if (!denied.ok) expect(denied.code).toBe("invalid-payload");
    const afterEvidence = await t.run((ctx) => ctx.db.get(shared.evidenceId));
    expect(afterEvidence).toEqual(beforeEvidence);
    const rows = await t.run((ctx) =>
      ctx.db
        .query("candidates")
        .withIndex("by_requirement", (q) => q.eq("requirementId", graph.requirementId))
        .take(count),
    );
    expect(rows.every((row) => row.compatibility === "pass")).toBe(true);
  });
});

describe("F1R-07 replays compare the full material snapshot", () => {
  test("public and internal exact replay deduplicates after verification and conflict without resetting state", async () => {
    const t = convexTest(schema, modules);
    const project = await setupProject(t, "replay-after-resolution");
    const args = {
      organizationId: project.orgId,
      projectId: project.projectId,
      field: "power",
      sourceKind: "manual",
      capturedAt: 1,
      originalValue: "220V",
      normalizedValue: "220V",
      freshness: "fresh" as const,
      counterpartyRole: "vendor" as const,
      idempotencyKey: "replay-after-resolution-public",
    };
    const first = await t.withIdentity(OWNER).mutation(recordProductEvidenceRef, args);
    expect(first.ok).toBe(true);
    if (!first.ok) throw new Error("public evidence setup failed");
    const resolved = await resolveVerified(t, project, first.evidenceId);
    const replay = await t.withIdentity(OWNER).mutation(recordProductEvidenceRef, args);
    expect(replay).toEqual({ ok: true, evidenceId: first.evidenceId, deduplicated: true });
    const conflict = await t.withIdentity(OWNER).mutation(recordProductEvidenceRef, {
      ...args,
      normalizedValue: "110V",
    });
    expect(conflict.ok).toBe(false);
    if (!conflict.ok) expect(conflict.code).toBe("duplicate-conflict");

    const internalArgs = {
      ...args,
      executionMode: "recorded" as const,
      idempotencyKey: "replay-after-resolution-internal",
    };
    const internal = await t.mutation(ingestProductEvidenceRef, internalArgs);
    expect(internal.ok).toBe(true);
    if (!internal.ok) throw new Error("internal evidence setup failed");
    await t.withIdentity(OWNER).mutation(linkEvidenceConflictRef, {
      organizationId: project.orgId,
      projectId: project.projectId,
      evidenceId: first.evidenceId,
      conflictingIds: [internal.evidenceId],
    });
    const internalReplay = await t.mutation(ingestProductEvidenceRef, internalArgs);
    expect(internalReplay).toEqual({ ok: true, evidenceId: internal.evidenceId, deduplicated: true });
    const publicRow = await t.run((ctx) => ctx.db.get(first.evidenceId));
    const internalRow = await t.run((ctx) => ctx.db.get(internal.evidenceId));
    expect(publicRow?.verification).toBe("conflicted");
    expect(publicRow?.version).not.toBe(resolved);
    expect(internalRow?.verification).toBe("unverified");
  });

  test("legacy evidence without an ingestion identity replays after verification without rewriting state", async () => {
    const t = convexTest(schema, modules);
    const project = await setupProject(t, "replay-legacy-identity");
    const args = {
      organizationId: project.orgId,
      projectId: project.projectId,
      field: "power",
      sourceKind: "manual",
      capturedAt: 1,
      originalValue: "220V",
      normalizedValue: "220V",
      freshness: "fresh" as const,
      lastCheckedAt: 7,
      counterpartyRole: "vendor" as const,
      idempotencyKey: "replay-legacy-identity",
    };
    const first = await t.withIdentity(OWNER).mutation(recordProductEvidenceRef, args);
    expect(first.ok).toBe(true);
    if (!first.ok) throw new Error("legacy evidence setup failed");
    await t.run(async (ctx) => {
      await ctx.db.patch(first.evidenceId, { ingestionIdentity: undefined });
    });
    const resolved = await resolveVerified(t, project, first.evidenceId);
    const beforeReplay = await t.run((ctx) => ctx.db.get(first.evidenceId));
    const replay = await t.withIdentity(OWNER).mutation(recordProductEvidenceRef, args);
    expect(replay).toEqual({ ok: true, evidenceId: first.evidenceId, deduplicated: true });
    const afterReplay = await t.run((ctx) => ctx.db.get(first.evidenceId));
    expect(afterReplay?.verification).toBe(beforeReplay?.verification);
    expect(afterReplay?.version).toBe(resolved);
    expect(afterReplay?.lastCheckedAt).toBe(beforeReplay?.lastCheckedAt);
    expect(afterReplay?.freshness).toBe("fresh");
    const changedFreshness = await t.withIdentity(OWNER).mutation(recordProductEvidenceRef, {
      ...args,
      freshness: "stale",
    });
    expect(changedFreshness.ok).toBe(false);
    if (!changedFreshness.ok) expect(changedFreshness.code).toBe("duplicate-conflict");
  });

  test("each omitted evidence field conflicts on the public path", async () => {
    const t = convexTest(schema, modules);
    const project = await setupProject(t, "replay-public");
    const asOwner = t.withIdentity(OWNER);
    const left = await setupGraph(t, project, "left");
    const right = await setupGraph(t, project, "right");
    const base = {
      organizationId: project.orgId,
      projectId: project.projectId,
      requirementId: left.requirementId,
      candidateId: left.candidateId,
      field: "power",
      sourceKind: "manual",
      sourceUrl: "https://example.test/left",
      capturedAt: 1,
      originalValue: "220V",
      normalizedValue: "220V",
      freshness: "fresh" as const,
      counterpartyRole: "vendor" as const,
    };
    const cases: { name: string; change: Record<string, unknown> }[] = [
      { name: "requirement", change: { requirementId: right.requirementId } },
      { name: "candidate", change: { candidateId: right.candidateId } },
      { name: "url", change: { sourceUrl: "https://example.test/right" } },
      { name: "captured", change: { capturedAt: 2 } },
      { name: "freshness", change: { freshness: "stale" as const } },
      { name: "checked", change: { lastCheckedAt: 5 } },
    ];
    for (const fieldCase of cases) {
      const key = `evidence-replay-${fieldCase.name}`;
      const first = await asOwner.mutation(recordProductEvidenceRef, { ...base, idempotencyKey: key });
      if (!first.ok) throw new Error(`base ${fieldCase.name} failed`);
      const divergent = await asOwner.mutation(recordProductEvidenceRef, {
        ...base,
        ...fieldCase.change,
        idempotencyKey: key,
      });
      expect(divergent.ok).toBe(false);
      if (!divergent.ok) expect(divergent.code).toBe("duplicate-conflict");
      const rows = await t.run((ctx) => ctx.db.query("productEvidence").collect());
      expect(rows.filter((row) => row.idempotencyKey === key)).toHaveLength(1);
    }
    const exact = await asOwner.mutation(recordProductEvidenceRef, {
      ...base,
      idempotencyKey: "evidence-replay-requirement",
    });
    if (!exact.ok) throw new Error("exact replay failed");
    expect(exact.deduplicated).toBe(true);
  });

  test("each omitted evidence field conflicts on the internal path", async () => {
    const t = convexTest(schema, modules);
    const project = await setupProject(t, "replay-internal");
    const left = await setupGraph(t, project, "left");
    const right = await setupGraph(t, project, "right");
    const base = {
      organizationId: project.orgId,
      projectId: project.projectId,
      requirementId: left.requirementId,
      candidateId: left.candidateId,
      field: "power",
      sourceKind: "collector",
      sourceUrl: "https://example.test/left",
      capturedAt: 1,
      originalValue: "220V",
      normalizedValue: "220V",
      freshness: "fresh" as const,
      counterpartyRole: "vendor" as const,
      executionMode: "recorded" as const,
    };
    const cases: { name: string; change: Record<string, unknown> }[] = [
      { name: "requirement", change: { requirementId: right.requirementId } },
      { name: "candidate", change: { candidateId: right.candidateId } },
      { name: "url", change: { sourceUrl: "https://example.test/right" } },
      { name: "captured", change: { capturedAt: 2 } },
      { name: "freshness", change: { freshness: "stale" as const } },
      { name: "checked", change: { lastCheckedAt: 5 } },
    ];
    for (const fieldCase of cases) {
      const key = `internal-replay-${fieldCase.name}`;
      const first = await t.mutation(ingestProductEvidenceRef, { ...base, idempotencyKey: key });
      if (!first.ok) throw new Error(`internal base ${fieldCase.name} failed`);
      const divergent = await t.mutation(ingestProductEvidenceRef, {
        ...base,
        ...fieldCase.change,
        idempotencyKey: key,
      });
      expect(divergent.ok).toBe(false);
      if (!divergent.ok) expect(divergent.code).toBe("duplicate-conflict");
      const rows = await t.run((ctx) => ctx.db.query("productEvidence").collect());
      expect(rows.filter((row) => row.idempotencyKey === key)).toHaveLength(1);
    }
    const exact = await t.mutation(ingestProductEvidenceRef, {
      ...base,
      idempotencyKey: "internal-replay-requirement",
    });
    if (!exact.ok) throw new Error("internal exact replay failed");
    expect(exact.deduplicated).toBe(true);
  });

  test("changed watch evidence conflicts; reordered evidence replays", async () => {
    const t = convexTest(schema, modules);
    const project = await setupProject(t, "replay-watch");
    const asOwner = t.withIdentity(OWNER);
    const graph = await setupGraph(t, project, "main");
    const originalEvidence = await recordFieldEvidence(
      t,
      project,
      { candidateId: graph.candidateId },
      "watch-original",
    );
    if (!originalEvidence.ok) throw new Error("original watch evidence setup failed");
    const replacementEvidence = await recordFieldEvidence(
      t,
      project,
      { candidateId: graph.candidateId },
      "watch-replacement",
    );
    if (!replacementEvidence.ok) throw new Error("replacement watch evidence setup failed");
    const base = {
      organizationId: project.orgId,
      projectId: project.projectId,
      targetKind: "candidate" as const,
      targetId: graph.candidateId,
      cadenceMs: 1000,
      counterpartyRole: "vendor" as const,
    };
    const first = await asOwner.mutation(createWatchRef, {
      ...base,
      evidenceRefs: [{ sourceId: originalEvidence.evidenceId, version: "1" }],
      idempotencyKey: "watch-evidence",
    });
    if (!first.ok) throw new Error("watch setup failed");
    const changed = await asOwner.mutation(createWatchRef, {
      ...base,
      evidenceRefs: [{ sourceId: replacementEvidence.evidenceId, version: "1" }],
      idempotencyKey: "watch-evidence",
    });
    expect(changed.ok).toBe(false);
    if (!changed.ok) expect(changed.code).toBe("duplicate-conflict");
    const exact = await asOwner.mutation(createWatchRef, {
      ...base,
      evidenceRefs: [{ sourceId: originalEvidence.evidenceId, version: "1" }],
      idempotencyKey: "watch-evidence",
    });
    if (!exact.ok) throw new Error("watch replay failed");
    expect(exact.deduplicated).toBe(true);
    const pair = await asOwner.mutation(createWatchRef, {
      ...base,
      evidenceRefs: [
        { sourceId: originalEvidence.evidenceId, version: "1" },
        { sourceId: replacementEvidence.evidenceId, version: "1" },
      ],
      idempotencyKey: "watch-evidence-order",
    });
    if (!pair.ok) throw new Error("watch pair setup failed");
    const reordered = await asOwner.mutation(createWatchRef, {
      ...base,
      evidenceRefs: [
        { sourceId: replacementEvidence.evidenceId, version: "1" },
        { sourceId: originalEvidence.evidenceId, version: "1" },
      ],
      idempotencyKey: "watch-evidence-order",
    });
    if (!reordered.ok) throw new Error("reordered replay failed");
    expect(reordered.deduplicated).toBe(true);
    expect(reordered.watchId).toBe(pair.watchId);
  });

  test("candidate watches resolve project-owned evidence before any write", async () => {
    const t = convexTest(schema, modules);
    const project = await setupProject(t, "watch-target-a");
    const foreignProject = await setupProject(t, "watch-target-b");
    const asOwner = t.withIdentity(OWNER);
    const local = await setupGraph(t, project, "local");
    const sameProjectOther = await setupGraph(t, project, "same-project-other");
    const foreign = await setupGraph(t, foreignProject, "foreign");
    const localEvidence = await recordFieldEvidence(
      t,
      project,
      { candidateId: local.candidateId },
      "watch-target-local-evidence",
    );
    if (!localEvidence.ok) throw new Error("local watch evidence setup failed");
    const sameProjectOtherEvidence = await recordFieldEvidence(
      t,
      project,
      { candidateId: sameProjectOther.candidateId },
      "watch-target-same-project-other-evidence",
    );
    if (!sameProjectOtherEvidence.ok) throw new Error("same-project watch evidence setup failed");
    const foreignEvidence = await recordFieldEvidence(
      t,
      foreignProject,
      { candidateId: foreign.candidateId },
      "watch-target-foreign-evidence",
    );
    if (!foreignEvidence.ok) throw new Error("foreign watch evidence setup failed");
    const restrictedProjectResult = await asOwner.mutation(createProjectRef, {
      organizationId: project.orgId,
      name: "watch-target-restricted",
      visibility: "restricted",
    });
    if (!restrictedProjectResult.ok) throw new Error("restricted watch project setup failed");
    const restrictedProject = {
      orgId: project.orgId,
      projectId: restrictedProjectResult.projectId,
    };
    const restricted = await setupGraph(t, restrictedProject, "restricted");
    const before = await t.run(async (ctx) => ({
      watches: (await ctx.db.query("watches").collect()).length,
      events: (await ctx.db.query("projectEvents").collect()).length,
    }));
    const assertNoRows = async () => {
      const after = await t.run(async (ctx) => ({
        watches: (await ctx.db.query("watches").collect()).length,
        events: (await ctx.db.query("projectEvents").collect()).length,
      }));
      expect(after).toEqual(before);
    };

    const foreignTarget = await asOwner.mutation(createWatchRef, {
      organizationId: project.orgId,
      projectId: project.projectId,
      targetKind: "candidate",
      targetId: foreign.candidateId,
      cadenceMs: 1000,
      counterpartyRole: "vendor",
      evidenceRefs: [{ sourceId: "missing-evidence", version: "1" }],
      idempotencyKey: "watch-target-foreign",
    });
    expect(foreignTarget.ok).toBe(false);
    await assertNoRows();

    const missingEvidence = await asOwner.mutation(createWatchRef, {
      organizationId: project.orgId,
      projectId: project.projectId,
      targetKind: "candidate",
      targetId: local.candidateId,
      cadenceMs: 1000,
      counterpartyRole: "vendor",
      evidenceRefs: [{ sourceId: "missing-evidence", version: "1" }],
      idempotencyKey: "watch-target-missing-evidence",
    });
    expect(missingEvidence.ok).toBe(false);
    await assertNoRows();

    const sameProjectWrongCandidate = await asOwner.mutation(createWatchRef, {
      organizationId: project.orgId,
      projectId: project.projectId,
      targetKind: "candidate",
      targetId: local.candidateId,
      cadenceMs: 1000,
      counterpartyRole: "vendor",
      evidenceRefs: [{ sourceId: sameProjectOtherEvidence.evidenceId, version: "1" }],
      idempotencyKey: "watch-target-same-project-wrong-candidate",
    });
    expect(sameProjectWrongCandidate).toMatchObject({ ok: false, code: "unrelated-evidence" });
    await assertNoRows();

    const foreignEvidenceRef = await asOwner.mutation(createWatchRef, {
      organizationId: project.orgId,
      projectId: project.projectId,
      targetKind: "candidate",
      targetId: local.candidateId,
      cadenceMs: 1000,
      counterpartyRole: "vendor",
      evidenceRefs: [{ sourceId: foreignEvidence.evidenceId, version: "1" }],
      idempotencyKey: "watch-target-foreign-evidence",
    });
    expect(foreignEvidenceRef.ok).toBe(false);
    await assertNoRows();

    const staleEvidence = await asOwner.mutation(createWatchRef, {
      organizationId: project.orgId,
      projectId: project.projectId,
      targetKind: "candidate",
      targetId: local.candidateId,
      cadenceMs: 1000,
      counterpartyRole: "vendor",
      evidenceRefs: [{ sourceId: localEvidence.evidenceId, version: "2" }],
      idempotencyKey: "watch-target-stale-evidence",
    });
    expect(staleEvidence.ok).toBe(false);
    await assertNoRows();

    const restrictedTarget = await asOwner.mutation(createWatchRef, {
      organizationId: project.orgId,
      projectId: project.projectId,
      targetKind: "candidate",
      targetId: restricted.candidateId,
      cadenceMs: 1000,
      counterpartyRole: "vendor",
      evidenceRefs: [{ sourceId: localEvidence.evidenceId, version: "1" }],
      idempotencyKey: "watch-target-restricted-project",
    });
    expect(restrictedTarget).toMatchObject({ ok: false, code: "denied-project" });
    await assertNoRows();

    const valid = await asOwner.mutation(createWatchRef, {
      organizationId: project.orgId,
      projectId: project.projectId,
      targetKind: "candidate",
      targetId: local.candidateId,
      cadenceMs: 1000,
      counterpartyRole: "vendor",
      evidenceRefs: [{ sourceId: localEvidence.evidenceId, version: "1" }],
      idempotencyKey: "watch-target-valid",
    });
    expect(valid.ok).toBe(true);
    const afterValid = await t.run(async (ctx) => ({
      watches: (await ctx.db.query("watches").collect()).length,
      events: (await ctx.db.query("projectEvents").collect()).length,
    }));
    expect(afterValid).toEqual({ watches: before.watches + 1, events: before.events });
  });

  test("RFQ vendor sets compare normalized", async () => {
    const t = convexTest(schema, modules);
    const project = await setupProject(t, "replay-rfq-vendors");
    const asOwner = t.withIdentity(OWNER);
    const graph = await setupGraph(t, project, "main");
    const secondVendor = await asOwner.mutation(recordVendorRef, {
      organizationId: project.orgId,
      name: "Vendor second",
      regions: ["NL"],
    });
    if (!secondVendor.ok) throw new Error("second vendor failed");
    const lineItems = [{ itemId: "machine", description: "Main machine", quantity: "1", unit: "piece" }];
    const first = await asOwner.mutation(createRfqRef, {
      organizationId: project.orgId,
      projectId: project.projectId,
      requirementId: graph.requirementId,
      idempotencyKey: "rfq-vendors",
      scenarioVendorIds: [graph.vendorId, secondVendor.vendorId],
      lineItems,
      briefHash: "vendor-scope",
      conversationState: "draft",
    });
    if (!first.ok) throw new Error("rfq setup failed");
    const reordered = await asOwner.mutation(createRfqRef, {
      organizationId: project.orgId,
      projectId: project.projectId,
      requirementId: graph.requirementId,
      idempotencyKey: "rfq-vendors",
      scenarioVendorIds: [secondVendor.vendorId, graph.vendorId],
      lineItems,
      briefHash: "vendor-scope",
      conversationState: "draft",
    });
    if (!reordered.ok) throw new Error("reordered replay failed");
    expect(reordered.deduplicated).toBe(true);
    expect(reordered.rfqId).toBe(first.rfqId);
    const narrowed = await asOwner.mutation(createRfqRef, {
      organizationId: project.orgId,
      projectId: project.projectId,
      requirementId: graph.requirementId,
      idempotencyKey: "rfq-vendors",
      scenarioVendorIds: [graph.vendorId],
      lineItems,
      briefHash: "vendor-scope",
      conversationState: "draft",
    });
    expect(narrowed.ok).toBe(false);
  });
});

describe("F1R-08 successors retain their offer lineage", () => {
  test("cross-offer supersession is denied without conversations", async () => {
    const t = convexTest(schema, modules);
    const project = await setupProject(t, "offer-cross");
    const asOwner = t.withIdentity(OWNER);
    const left = await setupGraph(t, project, "left");
    const right = await setupGraph(t, project, "right");
    const v1 = await asOwner.mutation(
      recordQuoteRef,
      quoteArgs(project, "v1", { requirementId: left.requirementId, vendorId: left.vendorId }),
    );
    if (!v1.ok) throw new Error("v1 failed");
    const crossed = await asOwner.mutation(
      recordQuoteRef,
      quoteArgs(project, "v2", {
        requirementId: right.requirementId,
        vendorId: right.vendorId,
        supersedes: v1.contentHash,
      }),
    );
    expect(crossed.ok).toBe(false);
  });

  test("a changed RFQ cannot ride an existing offer revision", async () => {
    const t = convexTest(schema, modules);
    const project = await setupProject(t, "offer-rfq");
    const asOwner = t.withIdentity(OWNER);
    const graph = await setupGraph(t, project, "main");
    const lineItems = [{ itemId: "machine", description: "Main machine", quantity: "1", unit: "piece" }];
    const rfqArgs = {
      organizationId: project.orgId,
      projectId: project.projectId,
      requirementId: graph.requirementId,
      scenarioVendorIds: [graph.vendorId],
      lineItems,
      briefHash: "offer-scope",
      conversationState: "draft" as const,
    };
    const rfqOne = await asOwner.mutation(createRfqRef, { ...rfqArgs, idempotencyKey: "rfq-offer-1" });
    if (!rfqOne.ok) throw new Error("rfq one failed");
    const rfqTwo = await asOwner.mutation(createRfqRef, { ...rfqArgs, idempotencyKey: "rfq-offer-2" });
    if (!rfqTwo.ok) throw new Error("rfq two failed");
    const v1 = await asOwner.mutation(
      recordQuoteRef,
      quoteArgs(project, "v1", {
        requirementId: graph.requirementId,
        vendorId: graph.vendorId,
        rfqId: rfqOne.rfqId,
      }),
    );
    if (!v1.ok) throw new Error("v1 failed");
    const moved = await asOwner.mutation(
      recordQuoteRef,
      quoteArgs(project, "v2", {
        requirementId: graph.requirementId,
        vendorId: graph.vendorId,
        rfqId: rfqTwo.rfqId,
        supersedes: v1.contentHash,
      }),
    );
    expect(moved.ok).toBe(false);
  });

  test("a valid same-offer revision is accepted without conversations", async () => {
    const t = convexTest(schema, modules);
    const project = await setupProject(t, "offer-same");
    const asOwner = t.withIdentity(OWNER);
    const graph = await setupGraph(t, project, "main");
    const rfq = await asOwner.mutation(createRfqRef, {
      organizationId: project.orgId,
      projectId: project.projectId,
      requirementId: graph.requirementId,
      idempotencyKey: "rfq-offer-same",
      scenarioVendorIds: [graph.vendorId],
      lineItems: [{ itemId: "machine", description: "Main machine", quantity: "1", unit: "piece" }],
      briefHash: "offer-scope",
      conversationState: "draft",
    });
    if (!rfq.ok) throw new Error("rfq failed");
    const v1 = await asOwner.mutation(
      recordQuoteRef,
      quoteArgs(project, "v1", {
        requirementId: graph.requirementId,
        vendorId: graph.vendorId,
        rfqId: rfq.rfqId,
      }),
    );
    if (!v1.ok) throw new Error("v1 failed");
    const v2 = await asOwner.mutation(
      recordQuoteRef,
      quoteArgs(project, "v2", {
        requirementId: graph.requirementId,
        vendorId: graph.vendorId,
        rfqId: rfq.rfqId,
        supersedes: v1.contentHash,
      }),
    );
    expect(v2.ok).toBe(true);
  });

  test("same-offer revisions hold with a shared conversation; crossings fail", async () => {
    const t = convexTest(schema, modules);
    const project = await setupProject(t, "offer-conversation");
    const asOwner = t.withIdentity(OWNER);
    const graph = await setupGraph(t, project, "main");
    const other = await setupGraph(t, project, "other");
    const first = await t.run(async (ctx) => {
      const now = Date.now();
      const grantId = await ctx.db.insert("grants", {
        organizationId: project.orgId,
        projectId: project.projectId,
        operations: ["communication.send"],
        communicationProfile: "ownerRoleplay",
        recipientConfigVersion: 1,
        inputVersions: {},
        canonicalPayload: "{}",
        payloadHash: "hash-offer",
        costCeilingMicroUsd: 100_000,
        roundLimit: 2,
        expiresAt: now + 3_600_000,
        revocationVersion: 1,
        status: "active",
        createdAt: now,
      });
      const conversationA = await ctx.db.insert("conversations", {
        organizationId: project.orgId,
        projectId: project.projectId,
        grantId,
        version: 1,
        state: "draft",
        recipientConfigVersion: 1,
        updatedAt: now,
      });
      const conversationB = await ctx.db.insert("conversations", {
        organizationId: project.orgId,
        projectId: project.projectId,
        grantId,
        version: 1,
        state: "draft",
        recipientConfigVersion: 1,
        updatedAt: now,
      });
      return { conversationA, conversationB };
    });
    const v1 = await asOwner.mutation(
      recordQuoteRef,
      quoteArgs(project, "v1", {
        requirementId: graph.requirementId,
        vendorId: graph.vendorId,
        conversationId: first.conversationA,
      }),
    );
    if (!v1.ok) throw new Error("v1 failed");
    const sameOffer = await asOwner.mutation(
      recordQuoteRef,
      quoteArgs(project, "v2", {
        requirementId: graph.requirementId,
        vendorId: graph.vendorId,
        conversationId: first.conversationA,
        supersedes: v1.contentHash,
      }),
    );
    expect(sameOffer.ok).toBe(true);
    const crossConversation = await asOwner.mutation(
      recordQuoteRef,
      quoteArgs(project, "v3", {
        requirementId: graph.requirementId,
        vendorId: graph.vendorId,
        conversationId: first.conversationB,
        supersedes: v1.contentHash,
      }),
    );
    expect(crossConversation.ok).toBe(false);
    const crossOffer = await asOwner.mutation(
      recordQuoteRef,
      quoteArgs(project, "v4", {
        requirementId: other.requirementId,
        vendorId: other.vendorId,
        conversationId: first.conversationA,
        supersedes: v1.contentHash,
      }),
    );
    expect(crossOffer.ok).toBe(false);
  });
});
