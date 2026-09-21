/// <reference types="vite/client" />
/**
 * E5 changed-term impact and substitution contract tests (P-11, P-12,
 * P-13, D-15).
 *
 * These tests execute the exported Convex handlers against convex-test's
 * in-memory database. They use controlled rows only, never provider calls,
 * supplier prices, or external evidence.
 */

import { convexTest } from "convex-test";
import { describe, expect, test } from "vitest";
import {
  makeFunctionReference,
  type RegisteredMutation,
  type RegisteredQuery,
} from "convex/server";
import type { Id } from "../_generated/dataModel.js";
import schema from "../schema.js";
import * as memberships from "../access/memberships.js";
import * as quotes from "../purchasing/contracts/quotes.js";
import * as requirements from "./requirements.js";
import * as sourcing from "./sourcing.js";
import * as decisions from "./decisions.js";
import * as fulfillment from "./fulfillment.js";
import * as workspace from "./workspace.js";
import * as impact from "./impact.js";
import { ALTERNATIVE_EVALUATION_BOUND, PROPOSAL_REASON_MAX_LENGTH } from "./impact.js";

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
type QueryArgs<T> = T extends RegisteredQuery<infer _V, infer A, infer _R> ? A : never;
type QueryReturn<T> = T extends RegisteredQuery<infer _V, infer _A, infer R> ? R : never;

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
const grantProjectAccessRef = makeFunctionReference<
  "mutation",
  MutationArgs<typeof memberships.grantProjectAccess>,
  MutationReturn<typeof memberships.grantProjectAccess>
>("access/memberships:grantProjectAccess");
const createRequirementRef = makeFunctionReference<
  "mutation",
  MutationArgs<typeof requirements.create>,
  MutationReturn<typeof requirements.create>
>("domain/requirements:create");
const updateRequirementRef = makeFunctionReference<
  "mutation",
  MutationArgs<typeof requirements.update>,
  MutationReturn<typeof requirements.update>
>("domain/requirements:update");
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
const recordQuoteRef = makeFunctionReference<
  "mutation",
  MutationArgs<typeof quotes.record>,
  MutationReturn<typeof quotes.record>
>("purchasing/contracts/quotes:record");
const recordSelectionRef = makeFunctionReference<
  "mutation",
  MutationArgs<typeof decisions.recordSelection>,
  MutationReturn<typeof decisions.recordSelection>
>("domain/decisions:recordSelection");
const recordOrderRef = makeFunctionReference<
  "mutation",
  MutationArgs<typeof fulfillment.recordOrder>,
  MutationReturn<typeof fulfillment.recordOrder>
>("domain/fulfillment:recordOrder");
const createWatchRef = makeFunctionReference<
  "mutation",
  MutationArgs<typeof workspace.createWatch>,
  MutationReturn<typeof workspace.createWatch>
>("domain/workspace:createWatch");
const createRfqRef = makeFunctionReference<
  "mutation",
  MutationArgs<typeof sourcing.createRfq>,
  MutationReturn<typeof sourcing.createRfq>
>("domain/sourcing:createRfq");
const assessQuoteRevisionImpactRef = makeFunctionReference<
  "mutation",
  MutationArgs<typeof impact.assessQuoteRevisionImpact>,
  MutationReturn<typeof impact.assessQuoteRevisionImpact>
>("domain/impact:assessQuoteRevisionImpact");
const assessWatchObservationRef = makeFunctionReference<
  "mutation",
  MutationArgs<typeof impact.assessWatchObservation>,
  MutationReturn<typeof impact.assessWatchObservation>
>("domain/impact:assessWatchObservation");
const createSubstituteProposalRef = makeFunctionReference<
  "mutation",
  MutationArgs<typeof impact.createSubstituteProposal>,
  MutationReturn<typeof impact.createSubstituteProposal>
>("domain/impact:createSubstituteProposal");
const decideSubstituteProposalRef = makeFunctionReference<
  "mutation",
  MutationArgs<typeof impact.decideSubstituteProposal>,
  MutationReturn<typeof impact.decideSubstituteProposal>
>("domain/impact:decideSubstituteProposal");
const getImpactAssessmentRef = makeFunctionReference<
  "query",
  QueryArgs<typeof impact.getImpactAssessment>,
  QueryReturn<typeof impact.getImpactAssessment>
>("domain/impact:getImpactAssessment");
const listImpactAssessmentsRef = makeFunctionReference<
  "query",
  QueryArgs<typeof impact.listImpactAssessments>,
  QueryReturn<typeof impact.listImpactAssessments>
>("domain/impact:listImpactAssessments");
const getSubstituteProposalRef = makeFunctionReference<
  "query",
  QueryArgs<typeof impact.getSubstituteProposal>,
  QueryReturn<typeof impact.getSubstituteProposal>
>("domain/impact:getSubstituteProposal");

const OWNER = { tokenIdentifier: "e5-impact-owner" };
const VIEWER = { tokenIdentifier: "e5-impact-viewer" };
const OTHER = { tokenIdentifier: "e5-impact-other" };

type Project = {
  organizationId: Id<"organizations">;
  projectId: Id<"projects">;
};

async function setupProject(
  t: ReturnType<typeof convexTest>,
  owner: { tokenIdentifier: string } = OWNER,
  name = "e5",
): Promise<Project> {
  const asOwner = t.withIdentity(owner);
  const organization = await asOwner.mutation(createOrganizationRef, {
    name: `${name} organization`,
    kind: "private",
  });
  if (!organization.ok) throw new Error("organization setup failed");
  const project = await asOwner.mutation(createProjectRef, {
    organizationId: organization.organizationId,
    name: `${name} project`,
    visibility: "open",
  });
  if (!project.ok) throw new Error("project setup failed");
  return { organizationId: organization.organizationId, projectId: project.projectId };
}

async function createRequirement(
  t: ReturnType<typeof convexTest>,
  project: Project,
  key: string,
  extra: Record<string, unknown> = {},
  identity: { tokenIdentifier: string } = OWNER,
): Promise<Id<"requirements">> {
  const result = await t.withIdentity(identity).mutation(createRequirementRef, {
    organizationId: project.organizationId,
    projectId: project.projectId,
    key,
    title: `Requirement ${key}`,
    category: "equipment",
    quantity: "2",
    unit: "piece",
    priority: "P1",
    ...extra,
  });
  if (!result.ok) throw new Error(`requirement setup failed: ${JSON.stringify(result)}`);
  return result.requirementId;
}

async function createVendor(
  t: ReturnType<typeof convexTest>,
  project: Project,
  name: string,
  identity: { tokenIdentifier: string } = OWNER,
): Promise<Id<"vendors">> {
  const result = await t.withIdentity(identity).mutation(recordVendorRef, {
    organizationId: project.organizationId,
    name,
    regions: ["NL"],
  });
  if (!result.ok) throw new Error(`vendor setup failed: ${JSON.stringify(result)}`);
  return result.vendorId;
}

async function createCandidate(
  t: ReturnType<typeof convexTest>,
  project: Project,
  requirementId: Id<"requirements">,
  vendorId: Id<"vendors">,
  label: string,
  identity: { tokenIdentifier: string } = OWNER,
): Promise<Id<"candidates">> {
  const result = await t.withIdentity(identity).mutation(recordCandidateRef, {
    organizationId: project.organizationId,
    projectId: project.projectId,
    requirementId,
    vendorId,
    productModel: `Model ${label}`,
    variant: `Variant ${label}`,
    conversationState: "draft",
  });
  if (!result.ok) throw new Error(`candidate setup failed: ${JSON.stringify(result)}`);
  return result.candidateId;
}

async function createQuote(
  t: ReturnType<typeof convexTest>,
  project: Project,
  requirementId: Id<"requirements">,
  vendorId: Id<"vendors">,
  version: string,
  supersedes?: string,
  identity: { tokenIdentifier: string } = OWNER,
): Promise<{ quoteId: Id<"quotes">; contentHash: string }> {
  const result = await t.withIdentity(identity).mutation(recordQuoteRef, {
    organizationId: project.organizationId,
    projectId: project.projectId,
    version,
    currency: "EUR",
    lines: [
      {
        lineId: `line-${version}`,
        description: `Item ${version}`,
        quantity: "2",
        unitPrice: { currency: "EUR", minorUnits: 1_000 },
        evidenceRefs: [],
      },
    ],
    charges: [],
    taxBasis: { kind: "inclusive", basisId: `controlled-${version}`, evidenceRefs: [] },
    evidenceRefs: [],
    requirementId,
    vendorId,
    ...(supersedes === undefined ? {} : { supersedes }),
  });
  if (!result.ok) throw new Error(`quote setup failed: ${JSON.stringify(result)}`);
  return { quoteId: result.quoteId, contentHash: result.contentHash };
}

async function selectQuote(
  t: ReturnType<typeof convexTest>,
  project: Project,
  requirementId: Id<"requirements">,
  candidateId: Id<"candidates">,
  quoteId: Id<"quotes">,
  quoteVersion: string,
  key: string,
): Promise<Id<"selections">> {
  const result = await t.withIdentity(OWNER).mutation(recordSelectionRef, {
    organizationId: project.organizationId,
    projectId: project.projectId,
    requirementId,
    candidateId,
    quoteId,
    quoteVersion,
    quantity: "2",
    requirementVersion: 1,
    idempotencyKey: key,
  });
  if (!result.ok) throw new Error(`selection setup failed: ${JSON.stringify(result)}`);
  return result.selectionId;
}

async function placeOrder(
  t: ReturnType<typeof convexTest>,
  project: Project,
  selectionId: Id<"selections">,
  key: string,
): Promise<Id<"orders">> {
  const result = await t.withIdentity(OWNER).mutation(recordOrderRef, {
    organizationId: project.organizationId,
    projectId: project.projectId,
    selectionId,
    orderedQuantity: "2",
    idempotencyKey: key,
  });
  if (!result.ok) throw new Error(`order setup failed: ${JSON.stringify(result)}`);
  return result.orderId;
}

async function createWatch(
  t: ReturnType<typeof convexTest>,
  project: Project,
  candidateId: Id<"candidates">,
  key: string,
  identity: { tokenIdentifier: string } = OWNER,
): Promise<Id<"watches">> {
  const result = await t.withIdentity(identity).mutation(createWatchRef, {
    organizationId: project.organizationId,
    projectId: project.projectId,
    targetKind: "candidate",
    targetId: candidateId,
    cadenceMs: 60_000,
    counterpartyRole: "ownerStandIn",
    idempotencyKey: key,
  });
  if (!result.ok) throw new Error(`watch setup failed: ${JSON.stringify(result)}`);
  return result.watchId;
}

interface Seed {
  requirementId: Id<"requirements">;
  candidateA: Id<"candidates">;
  candidateB: Id<"candidates">;
  vendorA: Id<"vendors">;
  vendorB: Id<"vendors">;
  quoteA1: Id<"quotes">;
  quoteA1Hash: string;
  quoteB1: { quoteId: Id<"quotes">; contentHash: string };
  selectionId: Id<"selections">;
}

/** Requirement with two candidates; candidate A's quote is selected. */
async function seedSelectedRequirement(
  t: ReturnType<typeof convexTest>,
  project: Project,
  key = "seed",
  placeAnOrder = false,
): Promise<Seed> {
  const requirementId = await createRequirement(t, project, key);
  const vendorA = await createVendor(t, project, `Vendor A ${key}`);
  const vendorB = await createVendor(t, project, `Vendor B ${key}`);
  const candidateA = await createCandidate(t, project, requirementId, vendorA, `A ${key}`);
  const candidateB = await createCandidate(t, project, requirementId, vendorB, `B ${key}`);
  const quoteA1 = await createQuote(t, project, requirementId, vendorA, `q-a1-${key}`);
  const quoteB1 = await createQuote(t, project, requirementId, vendorB, `q-b1-${key}`);
  const selectionId = await selectQuote(
    t,
    project,
    requirementId,
    candidateA,
    quoteA1.quoteId,
    `q-a1-${key}`,
    `${key}-selection`,
  );
  if (placeAnOrder) {
    await placeOrder(t, project, selectionId, `${key}-order`);
  }
  return {
    requirementId,
    candidateA,
    candidateB,
    vendorA,
    vendorB,
    quoteA1: quoteA1.quoteId,
    quoteA1Hash: quoteA1.contentHash,
    quoteB1,
    selectionId,
  };
}

function proposalArgs(
  project: Project,
  assessmentId: Id<"impactAssessments">,
  candidateB: Id<"candidates">,
  quoteB: Id<"quotes">,
  lineId: string,
  overrides: Record<string, unknown> = {},
) {
  return {
    organizationId: project.organizationId,
    projectId: project.projectId,
    idempotencyKey: "proposal-key",
    assessmentId,
    proposedCandidateId: candidateB,
    proposedQuoteId: quoteB,
    proposedLines: [{ quoteLineId: lineId, quantity: "2", unit: "piece" }],
    reason: "Selected revision was superseded; candidate B keeps current terms",
    ...overrides,
  };
}

describe("E5 impact assessments", () => {
  test("quote-revision trigger distinguishes an unplaced selection and re-evaluates alternatives", async () => {
    const t = convexTest(schema, modules);
    const project = await setupProject(t);
    const seed = await seedSelectedRequirement(t, project);
    const quoteA2 = await createQuote(t, project, seed.requirementId, seed.vendorA, "q-a2", seed.quoteA1Hash);
    const result = await t.withIdentity(OWNER).mutation(assessQuoteRevisionImpactRef, {
      organizationId: project.organizationId,
      projectId: project.projectId,
      idempotencyKey: "impact-unplaced",
      quoteId: quoteA2.quoteId,
    });
    if (!result.ok) throw new Error(`assessment failed: ${JSON.stringify(result)}`);
    expect(result.deduplicated).toBe(false);
    const view = await t.withIdentity(OWNER).query(getImpactAssessmentRef, {
      organizationId: project.organizationId,
      projectId: project.projectId,
      assessmentId: result.assessmentId,
    });
    if (!view.ok) throw new Error("assessment view failed");
    expect(view.assessment.trigger).toBe("quoteRevision");
    expect(view.assessment.requirementId).toBe(seed.requirementId);
    expect(view.assessment.quoteId).toBe(quoteA2.quoteId);
    expect(view.assessment.quoteVersion).toBe("q-a2");
    expect(view.assessment.predecessorQuoteId).toBe(seed.quoteA1);
    expect(view.assessment.predecessorQuoteVersion).toBe("q-a1-seed");
    expect(view.assessment.orderImpact).toBe("selectionOnly");
    expect(view.assessment.state).toBe("recorded");
    expect(view.assessment.affectedSelectionId).toBe(seed.selectionId);
    expect(view.assessment.placedOrderCount).toBe(0);
    expect(view.assessment.reason).toContain("was superseded by q-a2");
    expect(view.assessment.reason).toContain("unplaced selection");
    expect(view.assessment.evidenceRefs).toHaveLength(2);
    expect(view.assessment.alternatives).toHaveLength(2);
    const selected = view.assessment.alternatives.find(
      (entry: { candidateId: Id<"candidates"> }) => entry.candidateId === seed.candidateA,
    );
    expect(selected?.status).toBe("current");
    expect(selected?.note).toContain("currently selected candidate");
    const list = await t.withIdentity(OWNER).query(listImpactAssessmentsRef, {
      organizationId: project.organizationId,
      projectId: project.projectId,
      requirementId: seed.requirementId,
      limit: 10,
    });
    if (!list.ok) throw new Error("assessment list failed");
    expect(list.assessments).toHaveLength(1);
    expect(list.assessments[0]?.assessmentId).toBe(result.assessmentId);
  });

  test("assessment replay is idempotent and divergent keys conflict deterministically", async () => {
    const t = convexTest(schema, modules);
    const project = await setupProject(t);
    const seed = await seedSelectedRequirement(t, project);
    const quoteA2 = await createQuote(t, project, seed.requirementId, seed.vendorA, "q-a2", seed.quoteA1Hash);
    const args = {
      organizationId: project.organizationId,
      projectId: project.projectId,
      idempotencyKey: "impact-replay",
      quoteId: quoteA2.quoteId,
    };
    const first = await t.withIdentity(OWNER).mutation(assessQuoteRevisionImpactRef, args);
    if (!first.ok) throw new Error("assessment setup failed");
    const replay = await t.withIdentity(OWNER).mutation(assessQuoteRevisionImpactRef, args);
    if (!replay.ok) throw new Error("replay failed");
    expect(replay.deduplicated).toBe(true);
    expect(replay.assessmentId).toBe(first.assessmentId);
    // A second real revision with a divergent replay key conflicts; a
    // same-key retry against it is a deterministic duplicate-conflict.
    const quoteA3 = await createQuote(t, project, seed.requirementId, seed.vendorA, "q-a3", quoteA2.contentHash);
    const conflict = await t.withIdentity(OWNER).mutation(assessQuoteRevisionImpactRef, {
      ...args,
      quoteId: quoteA3.quoteId,
    });
    expect(conflict).toMatchObject({ ok: false, code: "duplicate-conflict" });
    const emptyKey = await t.withIdentity(OWNER).mutation(assessQuoteRevisionImpactRef, {
      ...args,
      idempotencyKey: "  ",
    });
    expect(emptyKey).toMatchObject({ ok: false, code: "invalid-payload" });
  });

  test("placed orders make the impact reviewRequired and keep order history untouched", async () => {
    const t = convexTest(schema, modules);
    const project = await setupProject(t);
    const seed = await seedSelectedRequirement(t, project, "placed", true);
    const orderBefore = await t.run(async (ctx) => {
      const rows = await ctx.db.query("orders").withIndex("by_project", (q) =>
        q.eq("projectId", project.projectId),
      ).collect();
      return rows[0]!;
    });
    const quoteA2 = await createQuote(t, project, seed.requirementId, seed.vendorA, "q-a2-placed", seed.quoteA1Hash);
    const result = await t.withIdentity(OWNER).mutation(assessQuoteRevisionImpactRef, {
      organizationId: project.organizationId,
      projectId: project.projectId,
      idempotencyKey: "impact-placed",
      quoteId: quoteA2.quoteId,
    });
    if (!result.ok) throw new Error("assessment failed");
    const view = await t.withIdentity(OWNER).query(getImpactAssessmentRef, {
      organizationId: project.organizationId,
      projectId: project.projectId,
      assessmentId: result.assessmentId,
    });
    if (!view.ok) throw new Error("assessment view failed");
    expect(view.assessment.orderImpact).toBe("reviewRequired");
    expect(view.assessment.placedOrderCount).toBe(1);
    expect(view.assessment.reason).toContain("keep their history");
    const orderAfter = await t.run(async (ctx) => ctx.db.get(orderBefore._id));
    expect(orderAfter).toEqual(orderBefore);
  });

  test("a failed watch check stays unknown and never marks a placed order delayed", async () => {
    const t = convexTest(schema, modules);
    const project = await setupProject(t);
    const seed = await seedSelectedRequirement(t, project, "watch", true);
    const watchId = await createWatch(t, project, seed.candidateA, "watch-key");
    const orderBefore = await t.run(async (ctx) => {
      const rows = await ctx.db.query("orders").withIndex("by_project", (q) =>
        q.eq("projectId", project.projectId),
      ).collect();
      return rows[0]!;
    });
    const failed = await t.withIdentity(OWNER).mutation(assessWatchObservationRef, {
      organizationId: project.organizationId,
      projectId: project.projectId,
      idempotencyKey: "watch-failed",
      watchId,
      result: "error",
    });
    if (!failed.ok) throw new Error(`watch assessment failed: ${JSON.stringify(failed)}`);
    const failedView = await t.withIdentity(OWNER).query(getImpactAssessmentRef, {
      organizationId: project.organizationId,
      projectId: project.projectId,
      assessmentId: failed.assessmentId,
    });
    if (!failedView.ok) throw new Error("assessment view failed");
    expect(failedView.assessment.state).toBe("unknown");
    expect(failedView.assessment.orderImpact).toBe("unknown");
    expect(failedView.assessment.watchResult).toBe("error");
    expect(failedView.assessment.reason).toContain("availability stays unknown");
    expect(failedView.assessment.reason).toContain("placed orders are unchanged");
    const orderAfter = await t.run(async (ctx) => ctx.db.get(orderBefore._id));
    expect(orderAfter).toEqual(orderBefore);
    expect(JSON.stringify(orderAfter)).not.toContain("delay");
    const replay = await t.withIdentity(OWNER).mutation(assessWatchObservationRef, {
      organizationId: project.organizationId,
      projectId: project.projectId,
      idempotencyKey: "watch-failed",
      watchId,
      result: "error",
    });
    if (!replay.ok) throw new Error("watch replay failed");
    expect(replay.deduplicated).toBe(true);
    expect(replay.assessmentId).toBe(failed.assessmentId);
    const conflict = await t.withIdentity(OWNER).mutation(assessWatchObservationRef, {
      organizationId: project.organizationId,
      projectId: project.projectId,
      idempotencyKey: "watch-failed",
      watchId,
      result: "ok",
    });
    expect(conflict).toMatchObject({ ok: false, code: "duplicate-conflict" });
    const stale = await t.withIdentity(OWNER).mutation(assessWatchObservationRef, {
      organizationId: project.organizationId,
      projectId: project.projectId,
      idempotencyKey: "watch-stale",
      watchId,
      result: "stale",
    });
    if (!stale.ok) throw new Error("stale watch assessment failed");
    const staleView = await t.withIdentity(OWNER).query(getImpactAssessmentRef, {
      organizationId: project.organizationId,
      projectId: project.projectId,
      assessmentId: stale.assessmentId,
    });
    if (!staleView.ok) throw new Error("stale view failed");
    expect(staleView.assessment.state).toBe("incomplete");
    expect(staleView.assessment.orderImpact).toBe("reviewRequired");
    const ok = await t.withIdentity(OWNER).mutation(assessWatchObservationRef, {
      organizationId: project.organizationId,
      projectId: project.projectId,
      idempotencyKey: "watch-ok",
      watchId,
      result: "ok",
    });
    if (!ok.ok) throw new Error("ok watch assessment failed");
    const okView = await t.withIdentity(OWNER).query(getImpactAssessmentRef, {
      organizationId: project.organizationId,
      projectId: project.projectId,
      assessmentId: ok.assessmentId,
    });
    if (!okView.ok) throw new Error("ok view failed");
    expect(okView.assessment.state).toBe("recorded");
    expect(okView.assessment.orderImpact).toBe("reviewRequired");
    const orderFinal = await t.run(async (ctx) => ctx.db.get(orderBefore._id));
    expect(orderFinal).toEqual(orderBefore);
  });

  test("a watch observation on a non-selected candidate does not touch the selection", async () => {
    const t = convexTest(schema, modules);
    const project = await setupProject(t);
    const seed = await seedSelectedRequirement(t, project, "watch-alt");
    const watchId = await createWatch(t, project, seed.candidateB, "watch-alt-key");
    const result = await t.withIdentity(OWNER).mutation(assessWatchObservationRef, {
      organizationId: project.organizationId,
      projectId: project.projectId,
      idempotencyKey: "watch-alt-impact",
      watchId,
      result: "ok",
    });
    if (!result.ok) throw new Error("watch assessment failed");
    const view = await t.withIdentity(OWNER).query(getImpactAssessmentRef, {
      organizationId: project.organizationId,
      projectId: project.projectId,
      assessmentId: result.assessmentId,
    });
    if (!view.ok) throw new Error("assessment view failed");
    expect(view.assessment.orderImpact).toBe("none");
    expect(view.assessment.affectedSelectionId).toBeUndefined();
    expect(view.assessment.placedOrderCount).toBe(0);
  });

  test("assessments enforce project authorization on every path", async () => {
    const t = convexTest(schema, modules);
    const project = await setupProject(t);
    const seed = await seedSelectedRequirement(t, project, "authz");
    const unauthenticated = await t.mutation(assessQuoteRevisionImpactRef, {
      organizationId: project.organizationId,
      projectId: project.projectId,
      idempotencyKey: "impact-noauth",
      quoteId: seed.quoteA1,
    });
    expect(unauthenticated).toMatchObject({ ok: false, code: "forged-identity" });
    await t.withIdentity(OWNER).mutation(grantProjectAccessRef, {
      organizationId: project.organizationId,
      projectId: project.projectId,
      targetIdentity: VIEWER.tokenIdentifier,
      role: "viewer",
    });
    const viewerDenied = await t.withIdentity(VIEWER).mutation(assessQuoteRevisionImpactRef, {
      organizationId: project.organizationId,
      projectId: project.projectId,
      idempotencyKey: "impact-viewer",
      quoteId: seed.quoteA1,
    });
    expect(viewerDenied).toMatchObject({ ok: false, code: "denied-capability" });
    const foreignProject = await setupProject(t, OTHER, "foreign");
    const foreignRequirementId = await createRequirement(t, foreignProject, "foreign-req", {}, OTHER);
    const foreignVendor = await createVendor(t, foreignProject, "Foreign vendor", OTHER);
    const foreignCandidate = await createCandidate(t, foreignProject, foreignRequirementId, foreignVendor, "foreign", OTHER);
    const foreignQuote = await createQuote(t, foreignProject, foreignRequirementId, foreignVendor, "q-foreign", undefined, OTHER);
    const foreignWatch = await createWatch(t, foreignProject, foreignCandidate, "foreign-watch", OTHER);
    const crossProject = await t.withIdentity(OWNER).mutation(assessQuoteRevisionImpactRef, {
      organizationId: project.organizationId,
      projectId: project.projectId,
      idempotencyKey: "impact-cross",
      quoteId: foreignQuote.quoteId,
    });
    expect(crossProject).toMatchObject({ ok: false, code: "denied-project" });
    const crossWatch = await t.withIdentity(OWNER).mutation(assessWatchObservationRef, {
      organizationId: project.organizationId,
      projectId: project.projectId,
      idempotencyKey: "watch-cross",
      watchId: foreignWatch,
      result: "ok",
    });
    expect(crossWatch).toMatchObject({ ok: false, code: "denied-project" });
  });

  test("quote-revision assessments require exact revision lineage", async () => {
    const t = convexTest(schema, modules);
    const project = await setupProject(t);
    const seed = await seedSelectedRequirement(t, project, "lineage");
    const notRevision = await t.withIdentity(OWNER).mutation(assessQuoteRevisionImpactRef, {
      organizationId: project.organizationId,
      projectId: project.projectId,
      idempotencyKey: "lineage-none",
      quoteId: seed.quoteA1,
    });
    expect(notRevision).toMatchObject({ ok: false, code: "invalid-payload" });
    // Controlled row: the public quote path refuses a dangling supersedes
    // hash, so the unresolvable predecessor is inserted directly.
    const danglingQuoteId = await t.run(async (ctx) =>
      ctx.db.insert("quotes", {
        organizationId: project.organizationId,
        projectId: project.projectId,
        version: "q-dangling",
        contentHash: "dangling-hash-not-resolvable",
        currency: "EUR",
        lines: [{
          lineId: "line-dangling",
          description: "Item dangling",
          quantity: "2",
          unitPrice: { currency: "EUR", minorUnits: 1_000 },
          evidenceRefs: [],
        }],
        charges: [],
        taxBasis: { kind: "inclusive", basisId: "controlled-dangling", evidenceRefs: [] },
        evidenceRefs: [],
        counterpartyRole: "userImport",
        executionMode: "recorded",
        requirementId: seed.requirementId,
        vendorId: seed.vendorA,
        supersedes: "hash-that-does-not-resolve",
        createdAt: Date.now(),
      }),
    );
    const dangling = await t.withIdentity(OWNER).mutation(assessQuoteRevisionImpactRef, {
      organizationId: project.organizationId,
      projectId: project.projectId,
      idempotencyKey: "lineage-dangling",
      quoteId: danglingQuoteId,
    });
    expect(dangling).toMatchObject({ ok: false, code: "invalid-payload" });
    const quoteA2 = await createQuote(t, project, seed.requirementId, seed.vendorA, "q-a2-lineage", seed.quoteA1Hash);
    const quoteA3 = await createQuote(t, project, seed.requirementId, seed.vendorA, "q-a3-lineage", quoteA2.contentHash);
    const unrelated = await t.withIdentity(OWNER).mutation(assessQuoteRevisionImpactRef, {
      organizationId: project.organizationId,
      projectId: project.projectId,
      idempotencyKey: "lineage-unrelated",
      quoteId: quoteA3.quoteId,
    });
    if (!unrelated.ok) throw new Error("unrelated assessment failed");
    const view = await t.withIdentity(OWNER).query(getImpactAssessmentRef, {
      organizationId: project.organizationId,
      projectId: project.projectId,
      assessmentId: unrelated.assessmentId,
    });
    if (!view.ok) throw new Error("assessment view failed");
    expect(view.assessment.orderImpact).toBe("none");
    expect(view.assessment.affectedSelectionId).toBeUndefined();
    expect(view.assessment.reason).toContain("pins another revision");
    const noSelection = await setupProject(t, OWNER, "noselection");
    const reqId = await createRequirement(t, noSelection, "noselection-req");
    const vendor = await createVendor(t, noSelection, "No-selection vendor");
    await createCandidate(t, noSelection, reqId, vendor, "no-selection");
    const quoteV1 = await createQuote(t, noSelection, reqId, vendor, "q-v1");
    const quoteV2 = await createQuote(t, noSelection, reqId, vendor, "q-v2", quoteV1.contentHash);
    const result = await t.withIdentity(OWNER).mutation(assessQuoteRevisionImpactRef, {
      organizationId: noSelection.organizationId,
      projectId: noSelection.projectId,
      idempotencyKey: "noselection-impact",
      quoteId: quoteV2.quoteId,
    });
    if (!result.ok) throw new Error("no-selection assessment failed");
    const noSelectionView = await t.withIdentity(OWNER).query(getImpactAssessmentRef, {
      organizationId: noSelection.organizationId,
      projectId: noSelection.projectId,
      assessmentId: result.assessmentId,
    });
    if (!noSelectionView.ok) throw new Error("no-selection view failed");
    expect(noSelectionView.assessment.orderImpact).toBe("none");
    expect(noSelectionView.assessment.reason).toContain("no selection exists");
  });

  test("an over-bound candidate set is explicitly incomplete, never a complete prefix", async () => {
    const t = convexTest(schema, modules);
    const project = await setupProject(t);
    const requirementId = await createRequirement(t, project, "bounded");
    for (let index = 0; index < ALTERNATIVE_EVALUATION_BOUND + 2; index += 1) {
      const vendorId = await createVendor(t, project, `Bound vendor ${index}`);
      await createCandidate(t, project, requirementId, vendorId, `bound-${index}`);
    }
    const vendorZero = await createVendor(t, project, "Bound vendor zero");
    await createCandidate(t, project, requirementId, vendorZero, "bound-zero");
    const quoteV1 = await createQuote(t, project, requirementId, vendorZero, "q-bound-v1");
    const quoteV2 = await createQuote(t, project, requirementId, vendorZero, "q-bound-v2", quoteV1.contentHash);
    const result = await t.withIdentity(OWNER).mutation(assessQuoteRevisionImpactRef, {
      organizationId: project.organizationId,
      projectId: project.projectId,
      idempotencyKey: "impact-bounded",
      quoteId: quoteV2.quoteId,
    });
    if (!result.ok) throw new Error("bounded assessment failed");
    const view = await t.withIdentity(OWNER).query(getImpactAssessmentRef, {
      organizationId: project.organizationId,
      projectId: project.projectId,
      assessmentId: result.assessmentId,
    });
    if (!view.ok) throw new Error("bounded view failed");
    expect(view.assessment.state).toBe("incomplete");
    expect(view.assessment.alternatives).toHaveLength(ALTERNATIVE_EVALUATION_BOUND);
  });
});

describe("E5 substitute proposals", () => {
  async function seedProposalContext(t: ReturnType<typeof convexTest>, key = "seed") {
    const project = await setupProject(t, OWNER, `proposal-${key}`);
    const seed = await seedSelectedRequirement(t, project, key, true);
    const quoteA2 = await createQuote(t, project, seed.requirementId, seed.vendorA, `q-a2-${key}`, seed.quoteA1Hash);
    const assessment = await t.withIdentity(OWNER).mutation(assessQuoteRevisionImpactRef, {
      organizationId: project.organizationId,
      projectId: project.projectId,
      idempotencyKey: `${key}-impact`,
      quoteId: quoteA2.quoteId,
    });
    if (!assessment.ok) throw new Error("assessment setup failed");
    return { project, seed, quoteA2, assessment, quoteB1: seed.quoteB1 };
  }

  test("proposal creation, fresh approval, and substitute execution preserve history", async () => {
    const t = convexTest(schema, modules);
    const { project, seed, assessment, quoteB1 } = await seedProposalContext(t, "approve");
    const historyBefore = await t.run(async (ctx) => ({
      orders: await ctx.db.query("orders").withIndex("by_project", (q) =>
        q.eq("projectId", project.projectId),
      ).collect(),
      selections: await ctx.db.query("selections").withIndex("by_project", (q) =>
        q.eq("projectId", project.projectId),
      ).collect(),
    }));
    const created = await t.withIdentity(OWNER).mutation(createSubstituteProposalRef, proposalArgs(
      project,
      assessment.assessmentId,
      seed.candidateB,
      quoteB1.quoteId,
      "line-q-b1-approve",
      { idempotencyKey: "proposal-approve" },
    ));
    if (!created.ok) throw new Error(`proposal failed: ${JSON.stringify(created)}`);
    expect(created.deduplicated).toBe(false);
    const view = await t.withIdentity(OWNER).query(getSubstituteProposalRef, {
      organizationId: project.organizationId,
      projectId: project.projectId,
      proposalId: created.proposalId,
    });
    if (!view.ok) throw new Error("proposal view failed");
    expect(view.proposal.state).toBe("pending");
    expect(view.proposal.proposedQuoteVersion).toBe("q-b1-approve");
    expect(view.proposal.currentSelectionId).toBe(seed.selectionId);
    // A contributor alone cannot decide a proposal: approval authority is required.
    await t.withIdentity(OWNER).mutation(grantProjectAccessRef, {
      organizationId: project.organizationId,
      projectId: project.projectId,
      targetIdentity: VIEWER.tokenIdentifier,
      role: "contributor",
    });
    const contributorDenied = await t.withIdentity(VIEWER).mutation(decideSubstituteProposalRef, {
      organizationId: project.organizationId,
      projectId: project.projectId,
      proposalId: created.proposalId,
      decision: "approved",
    });
    expect(contributorDenied).toMatchObject({ ok: false, code: "denied-capability" });
    const approved = await t.withIdentity(OWNER).mutation(decideSubstituteProposalRef, {
      organizationId: project.organizationId,
      projectId: project.projectId,
      proposalId: created.proposalId,
      decision: "approved",
    });
    if (!approved.ok) throw new Error(`approval failed: ${JSON.stringify(approved)}`);
    expect(approved.decisionApprovalId).toBeDefined();
    const approvedView = await t.withIdentity(OWNER).query(getSubstituteProposalRef, {
      organizationId: project.organizationId,
      projectId: project.projectId,
      proposalId: created.proposalId,
    });
    if (!approvedView.ok) throw new Error("approved view failed");
    expect(approvedView.proposal.state).toBe("approved");
    expect(approvedView.proposal.decisionApprovalId).toBe(approved.decisionApprovalId);
    const approvalRow = await t.run(async (ctx) => ctx.db.get(approved.decisionApprovalId!));
    expect(approvalRow).toMatchObject({
      scope: "substituteProposal",
      state: "approved",
      quoteId: quoteB1.quoteId,
      requirementId: seed.requirementId,
    });
    const approvalSnapshot = JSON.parse(approvalRow!.snapshotCanonical);
    expect(approvalSnapshot.currentSelectionId).toBe(seed.selectionId);
    // Decision replay safety: an identical approval retry returns the
    // stable original result without adding another approval row.
    const approvalRetry = await t.withIdentity(OWNER).mutation(decideSubstituteProposalRef, {
      organizationId: project.organizationId,
      projectId: project.projectId,
      proposalId: created.proposalId,
      decision: "approved",
    });
    if (!approvalRetry.ok) throw new Error("approval retry failed");
    expect(approvalRetry.decisionApprovalId).toBe(approved.decisionApprovalId);
    // An opposite later decision is a deterministic conflict with no writes.
    const reDecision = await t.withIdentity(OWNER).mutation(decideSubstituteProposalRef, {
      organizationId: project.organizationId,
      projectId: project.projectId,
      proposalId: created.proposalId,
      decision: "rejected",
    });
    expect(reDecision).toMatchObject({ ok: false, code: "duplicate-conflict" });
    // Executing the approved substitute is an explicit new selection; the
    // old selection, order, and approval history all remain intact.
    const substitute = await t.withIdentity(OWNER).mutation(recordSelectionRef, {
      organizationId: project.organizationId,
      projectId: project.projectId,
      requirementId: seed.requirementId,
      candidateId: seed.candidateB,
      quoteId: quoteB1.quoteId,
      quoteVersion: "q-b1-approve",
      quantity: "2",
      requirementVersion: 1,
      idempotencyKey: "substitute-selection",
    });
    if (!substitute.ok) throw new Error(`substitute selection failed: ${JSON.stringify(substitute)}`);
    const historyAfter = await t.run(async (ctx) => ({
      orders: await ctx.db.query("orders").withIndex("by_project", (q) =>
        q.eq("projectId", project.projectId),
      ).collect(),
      selections: await ctx.db.query("selections").withIndex("by_project", (q) =>
        q.eq("projectId", project.projectId),
      ).collect(),
      approvals: await ctx.db.query("approvals").withIndex("by_project", (q) =>
        q.eq("projectId", project.projectId),
      ).collect(),
    }));
    expect(historyAfter.orders).toEqual(historyBefore.orders);
    expect(historyAfter.selections).toHaveLength(historyBefore.selections.length + 1);
    expect(historyAfter.approvals).toHaveLength(1);
  });

  test("changed offer terms or requirement edits fence proposal approval", async () => {
    const t = convexTest(schema, modules);
    const { project, seed, assessment, quoteB1 } = await seedProposalContext(t, "fence");
    const created = await t.withIdentity(OWNER).mutation(createSubstituteProposalRef, proposalArgs(
      project,
      assessment.assessmentId,
      seed.candidateB,
      quoteB1.quoteId,
      "line-q-b1-fence",
      { idempotencyKey: "proposal-fence" },
    ));
    if (!created.ok) throw new Error("proposal setup failed");
    const quoteB2 = await createQuote(t, project, seed.requirementId, seed.vendorB, "q-b2-fence", quoteB1.contentHash);
    const fenced = await t.withIdentity(OWNER).mutation(decideSubstituteProposalRef, {
      organizationId: project.organizationId,
      projectId: project.projectId,
      proposalId: created.proposalId,
      decision: "approved",
    });
    expect(fenced).toMatchObject({ ok: false, code: "stale-proposal-basis" });
    const stillPending = await t.withIdentity(OWNER).query(getSubstituteProposalRef, {
      organizationId: project.organizationId,
      projectId: project.projectId,
      proposalId: created.proposalId,
    });
    if (!stillPending.ok) throw new Error("pending view failed");
    expect(stillPending.proposal.state).toBe("pending");
    // A pending proposal can still be rejected deterministically.
    const rejected = await t.withIdentity(OWNER).mutation(decideSubstituteProposalRef, {
      organizationId: project.organizationId,
      projectId: project.projectId,
      proposalId: created.proposalId,
      decision: "rejected",
    });
    if (!rejected.ok) throw new Error("rejection failed");
    expect(rejected.decisionApprovalId).toBeUndefined();
    // Rejection replay returns the stable result; approval now conflicts.
    const rejectionRetry = await t.withIdentity(OWNER).mutation(decideSubstituteProposalRef, {
      organizationId: project.organizationId,
      projectId: project.projectId,
      proposalId: created.proposalId,
      decision: "rejected",
    });
    if (!rejectionRetry.ok) throw new Error("rejection replay failed");
    expect(rejectionRetry.decisionApprovalId).toBeUndefined();
    const lateApproval = await t.withIdentity(OWNER).mutation(decideSubstituteProposalRef, {
      organizationId: project.organizationId,
      projectId: project.projectId,
      proposalId: created.proposalId,
      decision: "approved",
    });
    expect(lateApproval).toMatchObject({ ok: false, code: "duplicate-conflict" });
    // Requirement edits fence a fresh proposal the same way.
    const secondContext = await seedProposalContext(t, "fence2");
    const secondProposal = await t.withIdentity(OWNER).mutation(createSubstituteProposalRef, proposalArgs(
      secondContext.project,
      secondContext.assessment.assessmentId,
      secondContext.seed.candidateB,
      secondContext.quoteB1.quoteId,
      "line-q-b1-fence2",
      { idempotencyKey: "proposal-fence2" },
    ));
    if (!secondProposal.ok) throw new Error("second proposal setup failed");
    await t.withIdentity(OWNER).mutation(updateRequirementRef, {
      organizationId: secondContext.project.organizationId,
      projectId: secondContext.project.projectId,
      requirementId: secondContext.seed.requirementId,
      expectedVersion: 1,
      idempotencyKey: "fence2-requirement-edit",
      quantity: "3",
    });
    const requirementFenced = await t.withIdentity(OWNER).mutation(decideSubstituteProposalRef, {
      organizationId: secondContext.project.organizationId,
      projectId: secondContext.project.projectId,
      proposalId: secondProposal.proposalId,
      decision: "approved",
    });
    expect(requirementFenced).toMatchObject({ ok: false, code: "stale-proposal-basis" });
    // Replay-before-staleness: the exact original proposal call still
    // returns its stored row after the quote was superseded.
    const exactReplay = await t.withIdentity(OWNER).mutation(createSubstituteProposalRef, proposalArgs(
      project,
      assessment.assessmentId,
      seed.candidateB,
      quoteB1.quoteId,
      "line-q-b1-fence",
      { idempotencyKey: "proposal-fence" },
    ));
    if (!exactReplay.ok) throw new Error("exact replay failed");
    expect(exactReplay.deduplicated).toBe(true);
    expect(exactReplay.proposalId).toBe(created.proposalId);
    // A proposal cannot even be created on an already-superseded quote.
    const staleCreation = await t.withIdentity(OWNER).mutation(createSubstituteProposalRef, proposalArgs(
      project,
      assessment.assessmentId,
      seed.candidateB,
      quoteB1.quoteId,
      "line-q-b1-fence",
      { idempotencyKey: "proposal-stale-creation" },
    ));
    expect(staleCreation).toMatchObject({ ok: false, code: "stale-quote-version" });
    expect(quoteB2.contentHash).toBeDefined();
  });

  test("proposal idempotency, payload bounds, and quote-line validation are deterministic", async () => {
    const t = convexTest(schema, modules);
    const { project, seed, assessment, quoteB1 } = await seedProposalContext(t, "idem");
    const args = proposalArgs(project, assessment.assessmentId, seed.candidateB, quoteB1.quoteId, "line-q-b1-idem", {
      idempotencyKey: "proposal-idem",
    });
    const first = await t.withIdentity(OWNER).mutation(createSubstituteProposalRef, args);
    if (!first.ok) throw new Error(`proposal failed: ${JSON.stringify(first)}`);
    const replay = await t.withIdentity(OWNER).mutation(createSubstituteProposalRef, args);
    if (!replay.ok) throw new Error("replay failed");
    expect(replay.deduplicated).toBe(true);
    expect(replay.proposalId).toBe(first.proposalId);
    const conflict = await t.withIdentity(OWNER).mutation(createSubstituteProposalRef, {
      ...args,
      reason: "A different explanation",
    });
    expect(conflict).toMatchObject({ ok: false, code: "duplicate-conflict" });
    const emptyKey = await t.withIdentity(OWNER).mutation(createSubstituteProposalRef, {
      ...args,
      idempotencyKey: " ",
    });
    expect(emptyKey).toMatchObject({ ok: false, code: "invalid-payload" });
    const emptyReason = await t.withIdentity(OWNER).mutation(createSubstituteProposalRef, {
      ...args,
      idempotencyKey: "proposal-empty-reason",
      reason: "   ",
    });
    expect(emptyReason).toMatchObject({ ok: false, code: "invalid-payload" });
    const longReason = await t.withIdentity(OWNER).mutation(createSubstituteProposalRef, {
      ...args,
      idempotencyKey: "proposal-long-reason",
      reason: "x".repeat(PROPOSAL_REASON_MAX_LENGTH + 1),
    });
    expect(longReason).toMatchObject({ ok: false, code: "invalid-payload" });
    const foreignLine = await t.withIdentity(OWNER).mutation(createSubstituteProposalRef, {
      ...args,
      idempotencyKey: "proposal-foreign-line",
      proposedLines: [{ quoteLineId: "line-elsewhere", quantity: "2", unit: "piece" }],
    });
    expect(foreignLine).toMatchObject({ ok: false, code: "denied-project" });
    const overQuantity = await t.withIdentity(OWNER).mutation(createSubstituteProposalRef, {
      ...args,
      idempotencyKey: "proposal-over-quantity",
      proposedLines: [{ quoteLineId: "line-q-b1-idem", quantity: "5", unit: "piece" }],
    });
    expect(overQuantity).toMatchObject({ ok: false, code: "invalid-payload" });
    const badQuantity = await t.withIdentity(OWNER).mutation(createSubstituteProposalRef, {
      ...args,
      idempotencyKey: "proposal-bad-quantity",
      proposedLines: [{ quoteLineId: "line-q-b1-idem", quantity: "not-a-number", unit: "piece" }],
    });
    expect(badQuantity).toMatchObject({ ok: false, code: "invalid-payload" });
    const duplicateLine = await t.withIdentity(OWNER).mutation(createSubstituteProposalRef, {
      ...args,
      idempotencyKey: "proposal-duplicate-line",
      proposedLines: [
        { quoteLineId: "line-q-b1-idem", quantity: "1", unit: "piece" },
        { quoteLineId: "line-q-b1-idem", quantity: "1", unit: "piece" },
      ],
    });
    expect(duplicateLine).toMatchObject({ ok: false, code: "invalid-payload" });
    const emptyLines = await t.withIdentity(OWNER).mutation(createSubstituteProposalRef, {
      ...args,
      idempotencyKey: "proposal-empty-lines",
      proposedLines: [],
    });
    expect(emptyLines).toMatchObject({ ok: false, code: "invalid-payload" });
    // Cross-requirement candidate and quote references are denied.
    const otherRequirementId = await createRequirement(t, project, "idem-other");
    const otherVendor = await createVendor(t, project, "Idem other vendor");
    const otherCandidate = await createCandidate(t, project, otherRequirementId, otherVendor, "idem-other");
    const crossCandidate = await t.withIdentity(OWNER).mutation(createSubstituteProposalRef, {
      ...args,
      idempotencyKey: "proposal-cross-candidate",
      proposedCandidateId: otherCandidate,
    });
    expect(crossCandidate).toMatchObject({ ok: false, code: "denied-project" });
    const otherQuote = await createQuote(t, project, otherRequirementId, otherVendor, "q-idem-other");
    const crossQuote = await t.withIdentity(OWNER).mutation(createSubstituteProposalRef, {
      ...args,
      idempotencyKey: "proposal-cross-quote",
      proposedQuoteId: otherQuote.quoteId,
    });
    expect(crossQuote).toMatchObject({ ok: false, code: "denied-project" });
    // Mixed requirement/quote currency is refused exactly as selection refuses it.
    const eurRequirementId = await createRequirement(t, project, "idem-currency", { currency: "USD" });
    const currencyVendor = await createVendor(t, project, "Currency vendor");
    const currencyCandidate = await createCandidate(t, project, eurRequirementId, currencyVendor, "currency");
    const currencyQuote = await createQuote(t, project, eurRequirementId, currencyVendor, "q-currency-eur");
    const currencyAssessment = await t.withIdentity(OWNER).mutation(assessWatchObservationRef, {
      organizationId: project.organizationId,
      projectId: project.projectId,
      idempotencyKey: "currency-watch",
      watchId: await createWatch(t, project, currencyCandidate, "currency-watch-key"),
      result: "ok",
    });
    if (!currencyAssessment.ok) throw new Error("currency watch assessment failed");
    const mixedCurrency = await t.withIdentity(OWNER).mutation(createSubstituteProposalRef, {
      organizationId: project.organizationId,
      projectId: project.projectId,
      idempotencyKey: "proposal-currency",
      assessmentId: currencyAssessment.assessmentId,
      proposedCandidateId: currencyCandidate,
      proposedQuoteId: currencyQuote.quoteId,
      proposedLines: [{ quoteLineId: "line-q-currency-eur", quantity: "2", unit: "piece" }],
      reason: "Currency mismatch must be refused",
    });
    expect(mixedCurrency).toMatchObject({
      ok: false,
      code: "invalid-payload",
      message: "mixed-currency-requires-accepted-conversion-basis",
    });
    expect(seed.quoteA1).toBeDefined();
  });

  test("proposal creation enforces authoritative candidate-to-quote lineage", async () => {
    const t = convexTest(schema, modules);
    const { project, seed, assessment, quoteB1 } = await seedProposalContext(t, "lineage");
    // A quote bound to another vendor's offer can never back the proposal.
    const wrongVendor = await t.withIdentity(OWNER).mutation(createSubstituteProposalRef, proposalArgs(
      project,
      assessment.assessmentId,
      seed.candidateB,
      seed.quoteA1,
      `line-q-a1-lineage`,
      { idempotencyKey: "proposal-wrong-vendor" },
    ));
    expect(wrongVendor).toMatchObject({ ok: false, code: "denied-project", message: "proposed quote is bound to another vendor offer" });
    // An RFQ-scoped quote whose scope excludes the candidate vendor is
    // refused even when the quote itself carries no vendor binding.
    await t.withIdentity(OWNER).mutation(createRfqRef, {
      organizationId: project.organizationId,
      projectId: project.projectId,
      requirementId: seed.requirementId,
      idempotencyKey: "lineage-rfq",
      scenarioVendorIds: [seed.vendorA],
      lineItems: [{ itemId: "item-1", description: "Item 1", quantity: "2", unit: "piece" }],
      briefHash: "controlled-brief-hash",
      conversationState: "draft",
    });
    const scopedQuote = await t.withIdentity(OWNER).mutation(recordQuoteRef, {
      organizationId: project.organizationId,
      projectId: project.projectId,
      version: "q-rfq-lineage",
      currency: "EUR",
      lines: [{
        lineId: "line-q-rfq-lineage",
        description: "Item rfq",
        quantity: "2",
        unitPrice: { currency: "EUR", minorUnits: 1_000 },
        evidenceRefs: [],
      }],
      charges: [],
      taxBasis: { kind: "inclusive", basisId: "controlled-rfq", evidenceRefs: [] },
      evidenceRefs: [],
      requirementId: seed.requirementId,
      rfqId: (await t.run(async (ctx) => {
        const row = await ctx.db
          .query("rfqs")
          .withIndex("by_project_and_key", (q) =>
            q.eq("projectId", project.projectId).eq("idempotencyKey", "lineage-rfq"),
          )
          .unique();
        return row!._id;
      })),
    });
    if (!scopedQuote.ok) throw new Error(`rfq quote setup failed: ${JSON.stringify(scopedQuote)}`);
    const scopeExcluded = await t.withIdentity(OWNER).mutation(createSubstituteProposalRef, proposalArgs(
      project,
      assessment.assessmentId,
      seed.candidateB,
      scopedQuote.quoteId,
      "line-q-rfq-lineage",
      { idempotencyKey: "proposal-rfq-excluded" },
    ));
    expect(scopeExcluded).toMatchObject({ ok: false, code: "denied-project", message: "proposed quote RFQ scope excludes the candidate vendor" });
    // Positive control: a candidate whose vendor is inside the RFQ scope
    // passes the lineage checks, and no denial above wrote anything.
    const scopeIncluded = await t.withIdentity(OWNER).mutation(createSubstituteProposalRef, proposalArgs(
      project,
      assessment.assessmentId,
      seed.candidateA,
      scopedQuote.quoteId,
      "line-q-rfq-lineage",
      { idempotencyKey: "proposal-rfq-included" },
    ));
    if (!scopeIncluded.ok) throw new Error(`in-scope proposal failed: ${JSON.stringify(scopeIncluded)}`);
    expect(scopeIncluded.deduplicated).toBe(false);
    const pendingCount = await t.run(async (ctx) => {
      const rows = await ctx.db
        .query("substituteProposals")
        .withIndex("by_project", (q) => q.eq("projectId", project.projectId))
        .collect();
      return rows.filter((row) => row.state === "pending").length;
    });
    expect(pendingCount).toBe(1);
    expect(quoteB1.contentHash).toBeDefined();
  });

  test("selection drift between proposal creation and approval fences the decision", async () => {
    const t = convexTest(schema, modules);
    // Case A: the captured selection is replaced by another selection.
    const { project, seed, assessment, quoteB1 } = await seedProposalContext(t, "drift");
    const created = await t.withIdentity(OWNER).mutation(createSubstituteProposalRef, proposalArgs(
      project,
      assessment.assessmentId,
      seed.candidateB,
      quoteB1.quoteId,
      "line-q-b1-drift",
      { idempotencyKey: "proposal-drift" },
    ));
    if (!created.ok) throw new Error("proposal setup failed");
    await t.withIdentity(OWNER).mutation(recordSelectionRef, {
      organizationId: project.organizationId,
      projectId: project.projectId,
      requirementId: seed.requirementId,
      candidateId: seed.candidateB,
      quoteId: quoteB1.quoteId,
      quoteVersion: "q-b1-drift",
      quantity: "1",
      requirementVersion: 1,
      idempotencyKey: "drift-new-selection",
    });
    const drifted = await t.withIdentity(OWNER).mutation(decideSubstituteProposalRef, {
      organizationId: project.organizationId,
      projectId: project.projectId,
      proposalId: created.proposalId,
      decision: "approved",
    });
    expect(drifted).toMatchObject({ ok: false, code: "stale-proposal-basis" });
    const driftView = await t.withIdentity(OWNER).query(getSubstituteProposalRef, {
      organizationId: project.organizationId,
      projectId: project.projectId,
      proposalId: created.proposalId,
    });
    if (!driftView.ok) throw new Error("drift view failed");
    expect(driftView.proposal.state).toBe("pending");
    // Case B: the proposal was created with no selection and one arrives.
    const noSelectionProject = await setupProject(t, OWNER, "drift-noselection");
    const reqId = await createRequirement(t, noSelectionProject, "drift-noselection-req");
    const vendor = await createVendor(t, noSelectionProject, "Drift no-selection vendor");
    const candidate = await createCandidate(t, noSelectionProject, reqId, vendor, "drift-noselection");
    const quoteV1 = await createQuote(t, noSelectionProject, reqId, vendor, "q-ns-v1");
    const watchId = await createWatch(t, noSelectionProject, candidate, "drift-ns-watch");
    const watchAssessment = await t.withIdentity(OWNER).mutation(assessWatchObservationRef, {
      organizationId: noSelectionProject.organizationId,
      projectId: noSelectionProject.projectId,
      idempotencyKey: "drift-ns-impact",
      watchId,
      result: "ok",
    });
    if (!watchAssessment.ok) throw new Error("no-selection assessment failed");
    const noSelectionProposal = await t.withIdentity(OWNER).mutation(createSubstituteProposalRef, {
      organizationId: noSelectionProject.organizationId,
      projectId: noSelectionProject.projectId,
      idempotencyKey: "proposal-drift-noselection",
      assessmentId: watchAssessment.assessmentId,
      proposedCandidateId: candidate,
      proposedQuoteId: quoteV1.quoteId,
      proposedLines: [{ quoteLineId: "line-q-ns-v1", quantity: "2", unit: "piece" }],
      reason: "Watch observation suggests reviewing this candidate",
    });
    if (!noSelectionProposal.ok) throw new Error(`no-selection proposal failed: ${JSON.stringify(noSelectionProposal)}`);
    const capturedView = await t.withIdentity(OWNER).query(getSubstituteProposalRef, {
      organizationId: noSelectionProject.organizationId,
      projectId: noSelectionProject.projectId,
      proposalId: noSelectionProposal.proposalId,
    });
    if (!capturedView.ok) throw new Error("captured view failed");
    expect(capturedView.proposal.currentSelectionId).toBeUndefined();
    await t.withIdentity(OWNER).mutation(recordSelectionRef, {
      organizationId: noSelectionProject.organizationId,
      projectId: noSelectionProject.projectId,
      requirementId: reqId,
      candidateId: candidate,
      quoteId: quoteV1.quoteId,
      quoteVersion: "q-ns-v1",
      quantity: "2",
      requirementVersion: 1,
      idempotencyKey: "drift-ns-selection",
    });
    const becameSelected = await t.withIdentity(OWNER).mutation(decideSubstituteProposalRef, {
      organizationId: noSelectionProject.organizationId,
      projectId: noSelectionProject.projectId,
      proposalId: noSelectionProposal.proposalId,
      decision: "approved",
    });
    expect(becameSelected).toMatchObject({ ok: false, code: "stale-proposal-basis" });
    const approvalCount = await t.run(async (ctx) => {
      const rows = await ctx.db
        .query("approvals")
        .withIndex("by_project", (q) => q.eq("projectId", project.projectId))
        .collect();
      return rows.length;
    });
    expect(approvalCount).toBe(0);
  });
});
