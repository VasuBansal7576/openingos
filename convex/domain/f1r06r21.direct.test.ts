/// <reference types="vite/client" />
/**
 * Astra F1R-06 residual + F1R-21 regressions (review 86a7edf).
 *
 * Controlled contract only: actual exported sourcing handlers against the
 * real schema with authenticated identities via official convex-test. No
 * provider calls, mail, or external writes occur.
 *
 * - F1R-06 residual case 1: superseding an unused current-captured shared
 *   evidence row is not blocked by unrelated candidates (a complete
 *   current zero-dependent reverse index needs no requirement scan).
 * - F1R-06 residual case 2: conflicting one basis clears every affected
 *   candidate's whole reference list AND every basis's reverse-index rows,
 *   releasing the other basis's fanout capacity.
 * - F1R-06 migration: a historical row without ingestion identity keeps the
 *   bounded legacy fallback (denial past 256 candidates, zero writes).
 * - F1R-21: nonfinite roundLimit/expiresAt/targetMinorUnits deny with zero
 *   writes; boundary integers behave; pre-existing invalid rows are never
 *   usable authority via isUsableNegotiationMandate.
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
const recordQuoteRef = makeFunctionReference<
  "mutation",
  MutationArgs<typeof quotes.record>,
  MutationReturn<typeof quotes.record>
>("purchasing/contracts/quotes:record");
const openNegotiationRef = makeFunctionReference<
  "mutation",
  MutationArgs<typeof sourcing.openNegotiation>,
  MutationReturn<typeof sourcing.openNegotiation>
>("domain/sourcing:openNegotiation");

const OWNER = { tokenIdentifier: "f1r06r21-owner" };

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

async function addCandidates(
  t: ReturnType<typeof convexTest>,
  project: { orgId: Id<"organizations">; projectId: Id<"projects"> },
  graph: { requirementId: Id<"requirements">; vendorId: Id<"vendors"> },
  suffix: string,
  extra: number,
): Promise<Id<"candidates">[]> {
  const asOwner = t.withIdentity(OWNER);
  const ids: Id<"candidates">[] = [];
  for (let index = 0; index < extra; index += 1) {
    const created = await asOwner.mutation(recordCandidateRef, {
      organizationId: project.orgId,
      projectId: project.projectId,
      requirementId: graph.requirementId,
      vendorId: graph.vendorId,
      productModel: `Model ${suffix}-${index}`,
      variant: "220V",
      conversationState: "draft",
    });
    if (!created.ok) throw new Error("candidate setup failed");
    ids.push(created.candidateId);
  }
  return ids;
}

async function recordSharedEvidence(
  t: ReturnType<typeof convexTest>,
  project: { orgId: Id<"organizations">; projectId: Id<"projects"> },
  requirementId: Id<"requirements">,
  key: string,
) {
  const result = await t.withIdentity(OWNER).mutation(recordProductEvidenceRef, {
    organizationId: project.orgId,
    projectId: project.projectId,
    requirementId,
    field: "power",
    sourceKind: "manual",
    capturedAt: 1,
    originalValue: "220V",
    normalizedValue: "220V",
    freshness: "fresh",
    counterpartyRole: "vendor",
    idempotencyKey: key,
  });
  if (!result.ok) throw new Error("evidence setup failed");
  return result.evidenceId;
}

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

async function snapshotSourcing(t: ReturnType<typeof convexTest>) {
  return t.run((ctx) =>
    Promise.all([
      ctx.db.query("candidates").collect(),
      ctx.db.query("compatibilityEvidenceBindings").collect(),
      ctx.db.query("productEvidence").collect(),
      ctx.db.query("negotiations").collect(),
    ]),
  );
}

function quoteArgs(
  project: { orgId: Id<"organizations">; projectId: Id<"projects"> },
  version: string,
  refs: {
    requirementId?: Id<"requirements">;
    vendorId?: Id<"vendors">;
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
      requirementId: "req-f1r06r21",
      scopeId: "scope-r21",
      items: [{ itemId: "machine", lineId: "machine", unit: "piece", requiredQuantity: "1" }],
    },
    evidenceRefs: [],
    ...(refs.requirementId === undefined ? {} : { requirementId: refs.requirementId }),
    ...(refs.vendorId === undefined ? {} : { vendorId: refs.vendorId }),
  };
}

describe("F1R-06 residual shared-index lifecycle", () => {
  test("superseding unused current shared evidence is not blocked by 257 unrelated candidates", async () => {
    const t = convexTest(schema, modules);
    const project = await setupProject(t, "f1r06-unused");
    const graph = await setupGraph(t, project, "unused");
    await addCandidates(t, project, graph, "unused-extra", sourcing.MAX_COMPATIBILITY_FANOUT);
    const evidenceId = await recordSharedEvidence(t, project, graph.requirementId, "ev-unused");
    const before = await snapshotSourcing(t);
    expect(before[1]).toHaveLength(0);
    const superseded = await t.withIdentity(OWNER).mutation(verifyProductEvidenceRef, {
      organizationId: project.orgId,
      projectId: project.projectId,
      evidenceId,
      verdict: "superseded",
    });
    expect(superseded.ok).toBe(true);
    const after = await snapshotSourcing(t);
    expect(after[0]).toEqual(before[0]);
    expect(after[1]).toHaveLength(0);
    expect((await t.run((ctx) => ctx.db.get(evidenceId)))?.verification).toBe("superseded");
  });

  test("invalidating one basis deletes every binding and releases the other basis capacity", async () => {
    const t = convexTest(schema, modules);
    const project = await setupProject(t, "f1r06-cleanup");
    const asOwner = t.withIdentity(OWNER);
    const graph = await setupGraph(t, project, "cleanup");
    const extra = await addCandidates(t, project, graph, "cleanup-extra", sourcing.MAX_COMPATIBILITY_FANOUT - 1);
    const ids = [graph.candidateId, ...extra];
    expect(ids).toHaveLength(sourcing.MAX_COMPATIBILITY_FANOUT);
    const spare = await addCandidates(t, project, graph, "cleanup-spare", 1);
    const spareId = spare[0];
    if (spareId === undefined) throw new Error("spare candidate missing");

    const aId = await recordSharedEvidence(t, project, graph.requirementId, "ev-basis-a");
    const bId = await recordSharedEvidence(t, project, graph.requirementId, "ev-basis-b");
    const aVersion = await resolveVerified(t, project, aId);
    const bVersion = await resolveVerified(t, project, bId);
    for (const candidateId of ids) {
      const bound = await asOwner.mutation(verifyCompatibilityRef, {
        organizationId: project.orgId,
        projectId: project.projectId,
        candidateId,
        result: "pass",
        evidenceRefs: [
          { sourceId: aId, version: aVersion },
          { sourceId: bId, version: bVersion },
        ],
      });
      expect(bound.ok).toBe(true);
    }

    const conflictId = await recordSharedEvidence(t, project, graph.requirementId, "ev-basis-conflict");
    const before = await snapshotSourcing(t);
    const disputed = await asOwner.mutation(linkEvidenceConflictRef, {
      organizationId: project.orgId,
      projectId: project.projectId,
      evidenceId: aId,
      conflictingIds: [conflictId],
    });
    expect(disputed.ok).toBe(true);

    const after = await t.run((ctx) =>
      Promise.all([
        ctx.db.query("candidates").withIndex("by_requirement", (q) => q.eq("requirementId", graph.requirementId)).take(300),
        ctx.db.query("compatibilityEvidenceBindings").collect(),
        ctx.db.get(bId),
      ]),
    );
    // Every affected finding returns to unknown with its basis pins cleared.
    for (const row of after[0]) {
      if (ids.includes(row._id)) {
        expect(row.compatibility).toBe("unknown");
        expect(row.compatibilityEvidenceRefs ?? []).toHaveLength(0);
      }
    }
    // No reverse-index row survives for cleared candidates: both A's and
    // B's bindings are gone even though B stays verified.
    expect(after[1]).toHaveLength(0);
    expect(after[2]?.verification).toBe("verified");
    expect(before[1]).toHaveLength(sourcing.MAX_COMPATIBILITY_FANOUT * 2);

    // B's fanout capacity is released: a new dependent binds successfully.
    const rebound = await asOwner.mutation(verifyCompatibilityRef, {
      organizationId: project.orgId,
      projectId: project.projectId,
      candidateId: spareId,
      result: "pass",
      evidenceRefs: [{ sourceId: bId, version: bVersion }],
    });
    expect(rebound.ok).toBe(true);
  }, 15_000);

  test("historical row without ingestion identity keeps the bounded legacy fallback", async () => {
    const t = convexTest(schema, modules);
    const project = await setupProject(t, "f1r06-legacy");
    const graph = await setupGraph(t, project, "legacy");
    await addCandidates(t, project, graph, "legacy-extra", sourcing.MAX_COMPATIBILITY_FANOUT);
    const evidenceId = await recordSharedEvidence(t, project, graph.requirementId, "ev-legacy");
    await t.run((ctx) => ctx.db.patch(evidenceId, { ingestionIdentity: undefined }));
    const before = await snapshotSourcing(t);
    const denied = await t.withIdentity(OWNER).mutation(verifyProductEvidenceRef, {
      organizationId: project.orgId,
      projectId: project.projectId,
      evidenceId,
      verdict: "superseded",
    });
    expect(denied.ok).toBe(false);
    if (!denied.ok) expect(denied.code).toBe("invalid-payload");
    expect(await snapshotSourcing(t)).toEqual(before);
  });
});

describe("F1R-21 nonfinite negotiation mandates", () => {
  test.each([
    ["roundLimit", Number.NaN],
    ["roundLimit", Number.POSITIVE_INFINITY],
    ["expiresAt", Number.NaN],
    ["expiresAt", Number.POSITIVE_INFINITY],
    ["targetMinorUnits", Number.NaN],
    ["targetMinorUnits", Number.POSITIVE_INFINITY],
  ] as const)("denies nonfinite %s with zero writes", async (field, value) => {
    const t = convexTest(schema, modules);
    const project = await setupProject(t, `f1r21-${field}`);
    const graph = await setupGraph(t, project, `mandate-${field}`);
    const quote = await t.withIdentity(OWNER).mutation(
      recordQuoteRef,
      quoteArgs(project, "v1", { requirementId: graph.requirementId, vendorId: graph.vendorId }),
    );
    if (!quote.ok) throw new Error("quote setup failed");
    const before = await snapshotSourcing(t);
    const denied = await t.withIdentity(OWNER).mutation(openNegotiationRef, {
      organizationId: project.orgId,
      projectId: project.projectId,
      quoteId: quote.quoteId,
      mandateHash: "controlled",
      roundLimit: 3,
      expiresAt: Date.now() + 60_000,
      targetMinorUnits: 7_000_00,
      [field]: value,
    });
    expect(denied.ok).toBe(false);
    if (!denied.ok) expect(denied.code).toBe("invalid-payload");
    expect(await snapshotSourcing(t)).toEqual(before);
  });

  test("boundary integers: rejects 0/negative/fractional limits, accepts roundLimit 1 and zero target", async () => {
    const t = convexTest(schema, modules);
    const project = await setupProject(t, "f1r21-boundary");
    const graph = await setupGraph(t, project, "mandate-boundary");
    const quote = await t.withIdentity(OWNER).mutation(
      recordQuoteRef,
      quoteArgs(project, "v1", { requirementId: graph.requirementId, vendorId: graph.vendorId }),
    );
    if (!quote.ok) throw new Error("quote setup failed");
    const asOwner = t.withIdentity(OWNER);
    const base = {
      organizationId: project.orgId,
      projectId: project.projectId,
      quoteId: quote.quoteId,
      mandateHash: "controlled",
      roundLimit: 3,
      expiresAt: Date.now() + 60_000,
    };
    for (const roundLimit of [0, -1, 1.5, Number.MAX_SAFE_INTEGER + 1]) {
      const denied = await asOwner.mutation(openNegotiationRef, { ...base, roundLimit });
      expect(denied.ok).toBe(false);
    }
    const past = await asOwner.mutation(openNegotiationRef, { ...base, expiresAt: Date.now() - 1 });
    expect(past.ok).toBe(false);
    for (const targetMinorUnits of [-1, 1.5, Number.MAX_SAFE_INTEGER + 1]) {
      const denied = await asOwner.mutation(openNegotiationRef, { ...base, targetMinorUnits });
      expect(denied.ok).toBe(false);
    }
    const beforeCount = (await t.run((ctx) => ctx.db.query("negotiations").collect())).length;
    const minimal = await asOwner.mutation(openNegotiationRef, { ...base, roundLimit: 1 });
    expect(minimal.ok).toBe(true);
    const zeroTarget = await asOwner.mutation(openNegotiationRef, {
      ...base,
      mandateHash: "controlled-zero",
      targetMinorUnits: 0,
    });
    expect(zeroTarget.ok).toBe(true);
    expect((await t.run((ctx) => ctx.db.query("negotiations").collect())).length).toBe(beforeCount + 2);
  });

  test("pre-existing invalid rows are never usable authority", () => {
    const now = Date.now();
    const usable = {
      roundLimit: 3,
      expiresAt: now + 60_000,
      currency: "EUR",
      state: "active",
      roundsUsed: 0,
    };
    expect(sourcing.isUsableNegotiationMandate(usable, now)).toBe(true);
    expect(sourcing.isUsableNegotiationMandate({ ...usable, targetMinorUnits: 0 }, now)).toBe(true);
    const invalid = [
      { ...usable, roundLimit: Number.NaN },
      { ...usable, roundLimit: Number.POSITIVE_INFINITY },
      { ...usable, roundLimit: 0 },
      { ...usable, expiresAt: Number.NaN },
      { ...usable, expiresAt: Number.POSITIVE_INFINITY },
      { ...usable, expiresAt: now - 1 },
      { ...usable, targetMinorUnits: Number.NaN },
      { ...usable, targetMinorUnits: Number.POSITIVE_INFINITY },
      { ...usable, targetMinorUnits: -1 },
      { ...usable, state: "revoked" },
      { ...usable, roundsUsed: 3 },
    ];
    for (const row of invalid) {
      expect(sourcing.isUsableNegotiationMandate(row, now)).toBe(false);
    }
  });
});
