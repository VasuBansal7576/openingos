/**
 * F1R-22/F1R-23 lifecycle repair regressions (controlled).
 *
 * Covered here, and only here:
 * - reviewedResend enforces MAX_OPERATIONS_PER_GRANT / MAX_OPERATIONS_PER_JOB
 *   before insertion, so operation 65 is refused with zero new effect.
 * - The cancellation fence refuses resends before and during cleanup.
 * - listUnresolvedOperations enumerates every dispatching/outcomeUnknown
 *   operation ID beyond the first 16 with stable by_job pagination, returning
 *   the continuation even for an empty filtered page.
 * - Cancellation preserves durable unresolved truth across continuation,
 *   reload, and repeated calls without releasing unknown exposure.
 *
 * Controlled convex-test boundaries only; no provider calls.
 */

import { convexTest } from "convex-test";
import {
  makeFunctionReference,
  type RegisteredMutation,
  type RegisteredQuery,
} from "convex/server";
import { describe, expect, test } from "bun:test";
import schema from "../schema.js";
import type { Id } from "../_generated/dataModel.js";
import * as memberships from "../access/memberships.js";
import * as grants from "../access/grants.js";
import * as attempts from "./attempts.js";
import * as jobs from "./jobs.js";
import * as operations from "./operations.js";
import * as reservations from "./reservations.js";

const modules = {
  "./_generated/server.js": async () => await import("../_generated/server.js"),
  "./access/memberships.ts": async () => await import("../access/memberships.js"),
  "./access/grants.ts": async () => await import("../access/grants.js"),
  "./execution/jobs.ts": async () => await import("./jobs.js"),
  "./execution/attempts.ts": async () => await import("./attempts.js"),
  "./execution/operations.ts": async () => await import("./operations.js"),
  "./execution/reservations.ts": async () => await import("./reservations.js"),
  "./shared/scope.ts": async () => await import("../shared/scope.js"),
  "./shared/hashing.ts": async () => await import("../shared/hashing.js"),
  "./shared/sha256.ts": async () => await import("../shared/sha256.js"),
  "./shared/time.ts": async () => await import("../shared/time.js"),
  "./shared/denials.ts": async () => await import("../shared/denials.js"),
  "./shared/provenance.ts": async () => await import("../shared/provenance.js"),
  "./shared/mailbox.ts": async () => await import("../shared/mailbox.js"),
  "./access/checks.ts": async () => await import("../access/checks.js"),
  "./server.ts": async () => await import("../server.js"),
} satisfies Record<string, () => Promise<unknown>>;

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
const issueGrantRef = makeFunctionReference<
  "mutation",
  MutationArgs<typeof grants.issue>,
  MutationReturn<typeof grants.issue>
>("access/grants:issue");
const startJobRef = makeFunctionReference<
  "mutation",
  MutationArgs<typeof jobs.start>,
  MutationReturn<typeof jobs.start>
>("execution/jobs:start");
const cancelRef = makeFunctionReference<
  "mutation",
  MutationArgs<typeof jobs.cancel>,
  MutationReturn<typeof jobs.cancel>
>("execution/jobs:cancel");
const getJobRef = makeFunctionReference<
  "query",
  QueryArgs<typeof jobs.get>,
  Awaited<QueryReturn<typeof jobs.get>>
>("execution/jobs:get");
const listUnresolvedRef = makeFunctionReference<
  "query",
  QueryArgs<typeof jobs.listUnresolvedOperations>,
  Awaited<QueryReturn<typeof jobs.listUnresolvedOperations>>
>("execution/jobs:listUnresolvedOperations");
const reserveRef = makeFunctionReference<
  "mutation",
  MutationArgs<typeof reservations.reserve>,
  MutationReturn<typeof reservations.reserve>
>("execution/reservations:reserve");
const createOperationRef = makeFunctionReference<
  "mutation",
  MutationArgs<typeof operations.create>,
  MutationReturn<typeof operations.create>
>("execution/operations:create");
const claimRef = makeFunctionReference<
  "mutation",
  MutationArgs<typeof operations.claim>,
  MutationReturn<typeof operations.claim>
>("execution/operations:claim");
const reconcileAfterCrashRef = makeFunctionReference<
  "mutation",
  MutationArgs<typeof attempts.reconcileAfterCrash>,
  MutationReturn<typeof attempts.reconcileAfterCrash>
>("execution/attempts:reconcileAfterCrash");
const reviewedResendRef = makeFunctionReference<
  "mutation",
  MutationArgs<typeof attempts.reviewedResend>,
  MutationReturn<typeof attempts.reviewedResend>
>("execution/attempts:reviewedResend");

const RESEARCH_TEXT = "Research suppliers for espresso equipment";
const PAYLOAD_JSON = JSON.stringify({ query: RESEARCH_TEXT });

async function setupResearch() {
  const t = convexTest(schema, modules);
  const identity = { tokenIdentifier: "f1r22r23-owner" };
  const asOwner = t.withIdentity(identity);
  const organization = await asOwner.mutation(createOrganizationRef, {
    name: "Lifecycle repair test",
    kind: "private",
  });
  if (!organization.ok) throw new Error("organization setup failed");
  const organizationId = organization.organizationId;
  const project = await asOwner.mutation(createProjectRef, {
    organizationId,
    name: "Espresso opening",
    visibility: "open",
  });
  if (!project.ok) throw new Error("project setup failed");
  const projectId = project.projectId;
  const grant = await asOwner.mutation(issueGrantRef, {
    organizationId,
    projectId,
    operations: ["research.collect"],
    communicationProfile: "ownerRoleplay",
    recipientConfigVersion: 0,
    inputVersions: { brief: "v1" },
    payloadJson: PAYLOAD_JSON,
    costCeilingMicroUsd: 1_000_000,
    roundLimit: 1_000,
    expiresAt: Date.now() + 3_600_000,
  });
  if (!grant.ok) throw new Error("grant setup failed");
  const grantId = grant.grantId;
  await t.run(async (ctx) => {
    await ctx.db.insert("providerBudgets", {
      organizationId,
      ceilingMicroUsd: 1_000_000,
      reservedMicroUsd: 0,
      spentMicroUsd: 0,
      unresolvedMicroUsd: 0,
      pricingBasis: "controlled-f1r22r23",
      updatedAt: Date.now(),
    });
  });
  return { t, asOwner, identity, organizationId, projectId, grantId };
}

type Setup = Awaited<ReturnType<typeof setupResearch>>;

async function startJob(setup: Setup): Promise<Id<"jobs">> {
  const result = await setup.asOwner.mutation(startJobRef, {
    organizationId: setup.organizationId,
    projectId: setup.projectId,
    text: RESEARCH_TEXT,
    operationId: "research.collect",
    kind: "research",
    grantId: setup.grantId,
  });
  if (!result.ok) throw new Error(`job setup failed: ${result.message}`);
  return result.jobId;
}

async function reserveFor(setup: Setup, jobId: Id<"jobs">, amount = 10) {
  const result = await setup.asOwner.mutation(reserveRef, {
    jobId,
    organizationId: setup.organizationId,
    projectId: setup.projectId,
    amountMicroUsd: amount,
    pricingBasis: "controlled-f1r22r23",
  });
  if (!result.ok) throw new Error(`reserve failed: ${result.message}`);
  return result.reservationId;
}

async function createOp(
  setup: Setup,
  jobId: Id<"jobs">,
  requestId: string,
  reservationId?: Id<"reservations">,
) {
  const result = await setup.asOwner.mutation(createOperationRef, {
    jobId,
    organizationId: setup.organizationId,
    projectId: setup.projectId,
    kind: "research.collect",
    requestId,
    payloadJson: PAYLOAD_JSON,
    grantId: setup.grantId,
    ...(reservationId === undefined ? {} : { reservationId }),
  });
  if (!result.ok) throw new Error(`create ${requestId} failed: ${result.message}`);
  return result.operationId;
}

async function makeUnknown(setup: Setup, jobId: Id<"jobs">, requestId: string, amount = 10) {
  const reservationId = await reserveFor(setup, jobId, amount);
  const operationId = await createOp(setup, jobId, requestId, reservationId);
  const claim = await setup.t.mutation(claimRef, {
    operationId,
    identity: setup.identity.tokenIdentifier,
  });
  if (!claim.ok) throw new Error(`claim ${requestId} failed`);
  const reconciled = await setup.t.mutation(reconcileAfterCrashRef, { operationId });
  if (!reconciled.ok) throw new Error(`crash reconcile ${requestId} failed`);
  return { operationId, reservationId };
}

async function countOperations(setup: Setup): Promise<number> {
  return await setup.t.run(async (ctx) => (await ctx.db.query("operations").collect()).length);
}

async function drainCancellation(setup: Setup, jobId: Id<"jobs">) {
  const pages: Array<Awaited<MutationReturn<typeof jobs.cancel>>> = [];
  for (let index = 0; index < 100; index += 1) {
    const page = await setup.asOwner.mutation(cancelRef, {
      jobId,
      reason: "controlled cancellation continuation",
    });
    pages.push(page);
    if (page.ok && page.complete) return pages;
  }
  throw new Error("cancellation did not finish within the bounded continuation budget");
}

describe("F1R-22 reviewedResend admission limits", () => {
  test("operation 65 under one grant is refused with zero new effect", async () => {
    const setup = await setupResearch();
    const jobA = await startJob(setup);
    const origin = await makeUnknown(setup, jobA, "origin");
    const jobB = await startJob(setup);
    for (let index = 0; index < 63; index += 1) {
      await createOp(setup, jobB, `grant-fill-${index}`);
    }
    expect(await countOperations(setup)).toBe(64);
    const fresh = await reserveFor(setup, jobA, 10);
    const before = await countOperations(setup);
    const resend = await setup.t.mutation(reviewedResendRef, {
      operationId: origin.operationId,
      identity: setup.identity.tokenIdentifier,
      newRequestId: "sixty-five",
      newReservationId: fresh,
    });
    expect(resend.ok).toBe(false);
    if (resend.ok) throw new Error("resend should have been refused");
    expect(resend.code).toBe("operation-admission-limit");
    expect(await countOperations(setup)).toBe(before);
  });

  test("operation 65 on one job is refused with zero new effect", async () => {
    const setup = await setupResearch();
    const jobId = await startJob(setup);
    const origin = await makeUnknown(setup, jobId, "origin");
    for (let index = 0; index < 63; index += 1) {
      await createOp(setup, jobId, `job-fill-${index}`);
    }
    expect(await countOperations(setup)).toBe(64);
    const fresh = await reserveFor(setup, jobId, 10);
    const before = await countOperations(setup);
    const resend = await setup.t.mutation(reviewedResendRef, {
      operationId: origin.operationId,
      identity: setup.identity.tokenIdentifier,
      newRequestId: "sixty-five",
      newReservationId: fresh,
    });
    expect(resend.ok).toBe(false);
    if (resend.ok) throw new Error("resend should have been refused");
    expect(resend.code).toBe("operation-admission-limit");
    expect(await countOperations(setup)).toBe(before);
  });

  test("resend after the cancellation fence writes nothing", async () => {
    const setup = await setupResearch();
    const jobId = await startJob(setup);
    const origin = await makeUnknown(setup, jobId, "origin", 30);
    const unused: Array<Id<"reservations">> = [];
    for (let index = 0; index < 17; index += 1) {
      unused.push(await reserveFor(setup, jobId, 1));
    }
    const first = await setup.asOwner.mutation(cancelRef, { jobId, reason: "stop" });
    expect(first).toMatchObject({ ok: true, state: "cancelling", complete: false });
    const before = await countOperations(setup);
    const resend = await setup.t.mutation(reviewedResendRef, {
      operationId: origin.operationId,
      identity: setup.identity.tokenIdentifier,
      newRequestId: "post-fence",
      newReservationId: unused[unused.length - 1]!,
    });
    expect(resend.ok).toBe(false);
    if (resend.ok) throw new Error("fenced resend should have been refused");
    expect(resend.code).toBe("cancelled-before-claim");
    expect(await countOperations(setup)).toBe(before);
    const pages = await drainCancellation(setup, jobId);
    const final = pages[pages.length - 1]!;
    expect(final.ok).toBe(true);
    const state = await setup.t.run(async (ctx) => ({
      operations: await ctx.db.query("operations").collect(),
      budget: (await ctx.db.query("providerBudgets").collect())[0]!,
    }));
    expect(state.operations.filter((op) => op.state === "prepared")).toHaveLength(0);
    expect(state.budget.reservedMicroUsd).toBe(30);
  });
});

describe("F1R-23 unresolved operation inventory", () => {
  test("enumerates every unresolved ID beyond the first 16", async () => {
    const setup = await setupResearch();
    const jobId = await startJob(setup);
    const expected: Array<Id<"operations">> = [];
    for (let index = 0; index < 20; index += 1) {
      const { operationId } = await makeUnknown(setup, jobId, `unknown-${index}`, 1);
      expected.push(operationId);
    }
    const collected: Array<Id<"operations">> = [];
    let cursor: string | undefined;
    let pages = 0;
    let done = false;
    while (!done) {
      pages += 1;
      const page = await setup.asOwner.query(listUnresolvedRef, {
        jobId,
        ...(cursor === undefined ? {} : { cursor }),
        limit: 16,
      });
      expect(page.ok).toBe(true);
      if (!page.ok) throw new Error("inventory query failed");
      collected.push(...page.operationIds);
      if (pages === 1) expect(page.continueCursor).not.toBeNull();
      done = page.isDone;
      cursor = page.continueCursor ?? undefined;
      if (pages > 10) throw new Error("inventory pagination did not terminate");
    }
    expect(pages).toBeGreaterThan(1);
    expect(new Set(collected)).toEqual(new Set(expected));
    expect(collected).toHaveLength(20);
    for (const id of expected.slice(16)) {
      expect(collected).toContain(id);
    }
  });

  test("an empty filtered page still returns its continuation", async () => {
    const setup = await setupResearch();
    const jobId = await startJob(setup);
    for (let index = 0; index < 16; index += 1) {
      await createOp(setup, jobId, `pad-${index}`);
    }
    const tail: Array<Id<"operations">> = [];
    for (let index = 0; index < 2; index += 1) {
      const { operationId } = await makeUnknown(setup, jobId, `tail-${index}`, 1);
      tail.push(operationId);
    }
    const first = await setup.asOwner.query(listUnresolvedRef, { jobId, limit: 16 });
    expect(first.ok).toBe(true);
    if (!first.ok) throw new Error("first inventory page failed");
    expect(first.operationIds).toHaveLength(0);
    expect(first.isDone).toBe(false);
    expect(first.continueCursor).not.toBeNull();
    const second = await setup.asOwner.query(listUnresolvedRef, {
      jobId,
      cursor: first.continueCursor!,
      limit: 16,
    });
    expect(second.ok).toBe(true);
    if (!second.ok) throw new Error("second inventory page failed");
    expect(new Set(second.operationIds)).toEqual(new Set(tail));
    expect(second.isDone).toBe(true);
    expect(second.continueCursor).toBeNull();
  });

  test("invalid limits are denied before pagination and large limits clamp to one page", async () => {
    const setup = await setupResearch();
    const jobId = await startJob(setup);
    await makeUnknown(setup, jobId, "unknown-0", 1);
    for (const limit of [Number.NaN, Number.POSITIVE_INFINITY, 0, -3, 2.5]) {
      const denied = await setup.asOwner.query(listUnresolvedRef, { jobId, limit });
      expect(denied).toMatchObject({ ok: false, code: "invalid-payload" });
    }
    const clamped = await setup.asOwner.query(listUnresolvedRef, { jobId, limit: 1000 });
    expect(clamped.ok).toBe(true);
    if (!clamped.ok) throw new Error("clamped query failed");
    expect(clamped.operationIds).toHaveLength(1);
    expect(clamped.isDone).toBe(true);
  });

  test("the inventory requires authentication and project authorization", async () => {
    const setup = await setupResearch();
    const jobId = await startJob(setup);
    const unauthenticated = await setup.t.query(listUnresolvedRef, { jobId });
    expect(unauthenticated).toMatchObject({ ok: false, code: "forged-identity" });
    const other = await setupResearch();
    const foreign = await other.asOwner.query(listUnresolvedRef, { jobId });
    expect(foreign).toMatchObject({ ok: false, code: "denied-membership" });
  });
});

describe("F1R-22/F1R-23 durable unresolved truth", () => {
  test("repeat cancellation keeps the count, the IDs, and the exposure", async () => {
    const setup = await setupResearch();
    const jobId = await startJob(setup);
    const origin = await makeUnknown(setup, jobId, "origin", 30);
    const pages = await drainCancellation(setup, jobId);
    const final = pages[pages.length - 1]!;
    expect(final.ok).toBe(true);
    if (!final.ok) throw new Error("cancellation failed");
    expect(final.state).toBe("cancelled");
    expect(final.unresolvedOperationIds).toContain(origin.operationId);
    expect(final.unresolvedOperationCount).toBe(1);
    expect(final.reconciliationComplete).toBe(false);
    const repeat = await setup.asOwner.mutation(cancelRef, { jobId, reason: "reload" });
    expect(repeat.ok).toBe(true);
    if (!repeat.ok) throw new Error("repeat cancellation failed");
    expect(repeat).toMatchObject({
      state: "cancelled",
      unresolvedOperationCount: 1,
      reconciliationComplete: false,
    });
    if (repeat.ok) expect(repeat.unresolvedOperationIds).toContain(origin.operationId);
    const stored = await setup.asOwner.query(getJobRef, { jobId });
    expect(stored).toMatchObject({
      ok: true,
      state: "cancelled",
      cancellationUnresolvedOperationCount: 1,
      cancellationReconciliationComplete: false,
    });
    const ledger = await setup.t.run(async (ctx) => ({
      operation: await ctx.db.get(origin.operationId),
      reservation: await ctx.db.get(origin.reservationId),
    }));
    expect(ledger.operation?.state).toBe("outcomeUnknown");
    expect(ledger.reservation?.reservedMicroUsd).toBe(30);
  });
});
