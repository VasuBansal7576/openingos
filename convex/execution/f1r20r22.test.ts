/**
 * F1R-20/F1R-22 backend regressions.
 *
 * These are controlled Convex-handler tests. They never contact a provider;
 * the assertions cover the real registered job, reservation, operation and
 * claim boundaries plus finite admission under interleaved calls.
 */

import { convexTest } from "convex-test";
import {
  makeFunctionReference,
  type RegisteredMutation,
} from "convex/server";
import { describe, expect, test } from "bun:test";
import schema from "../schema.js";
import * as memberships from "../access/memberships.js";
import * as grants from "../access/grants.js";
import * as jobs from "./jobs.js";
import * as operations from "./operations.js";
import * as reservations from "./reservations.js";
import {
  classifyScope,
  MAX_JOBS_PER_GRANT,
  MAX_RESERVATIONS_PER_JOB,
} from "../shared/scope.js";

const modules = {
  "./_generated/server.js": async () => await import("../_generated/server.js"),
  "./access/memberships.ts": async () => await import("../access/memberships.js"),
  "./access/grants.ts": async () => await import("../access/grants.js"),
  "./execution/jobs.ts": async () => await import("./jobs.js"),
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
const cancelRef = makeFunctionReference<
  "mutation",
  MutationArgs<typeof jobs.cancel>,
  MutationReturn<typeof jobs.cancel>
>("execution/jobs:cancel");

async function setupResearch() {
  const t = convexTest(schema, modules);
  const identity = { tokenIdentifier: "f1r20r22-owner" };
  const asOwner = t.withIdentity(identity);
  const organization = await asOwner.mutation(createOrganizationRef, {
    name: "Bounded purchasing test",
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
    payloadJson: JSON.stringify({ query: "Research suppliers for espresso equipment" }),
    costCeilingMicroUsd: 10_000,
    roundLimit: 1_000,
    expiresAt: Date.now() + 3_600_000,
  });
  if (!grant.ok) throw new Error("grant setup failed");
  const grantId = grant.grantId;
  await t.run(async (ctx) => {
    await ctx.db.insert("providerBudgets", {
      organizationId,
      ceilingMicroUsd: 10_000,
      reservedMicroUsd: 0,
      spentMicroUsd: 0,
      unresolvedMicroUsd: 0,
      pricingBasis: "controlled-f1r20r22",
      updatedAt: Date.now(),
    });
  });
  return { t, asOwner, identity, organizationId, projectId, grantId };
}

async function countRows(t: ReturnType<typeof convexTest>) {
  return await t.run(async (ctx) => ({
    grants: (await ctx.db.query("grants").collect()).length,
    jobs: (await ctx.db.query("jobs").collect()).length,
    operations: (await ctx.db.query("operations").collect()).length,
    reservations: (await ctx.db.query("reservations").collect()).length,
    attempts: (await ctx.db.query("attempts").collect()).length,
  }));
}

async function startPurchasingJob(setup: Awaited<ReturnType<typeof setupResearch>>, requestText = "Research suppliers for espresso equipment") {
  const result = await setup.asOwner.mutation(startJobRef, {
    organizationId: setup.organizationId,
    projectId: setup.projectId,
    text: requestText,
    operationId: "research.collect",
    kind: "research",
    grantId: setup.grantId,
  });
  if (!result.ok) throw new Error(`job setup failed: ${result.message}`);
  return result.jobId;
}

describe("F1R-20 allowlisted workflow purpose", () => {
  test("structured project context admits short follow-ups without laundering an unrelated topic", () => {
    const projectContext = {
      organizationId: "org-controlled",
      projectId: "project-controlled",
      projectName: "Espresso opening",
      terms: ["espresso machine", "coffee"],
      hasStructuredContext: true,
    };
    expect(
      classifyScope({
        text: "What changes if they choose another option?",
        projectContext,
      }).verdict,
    ).toBe("supported");
    expect(
      classifyScope({
        text: "Research suppliers for football transfer rumors",
        operationId: "research.collect",
        projectContext,
      }).verdict,
    ).toBe("unrelatedRefused");
  });

  test("the three exact unrelated probes refuse with zero backend effects", async () => {
    const setup = await setupResearch();
    const unrelatedGrant = await setup.asOwner.mutation(issueGrantRef, {
      organizationId: setup.organizationId,
      projectId: setup.projectId,
      operations: ["research.collect"],
      communicationProfile: "ownerRoleplay",
      recipientConfigVersion: 0,
      inputVersions: { brief: "football" },
      payloadJson: JSON.stringify({ query: "Football transfer rumors" }),
      costCeilingMicroUsd: 100,
      roundLimit: 3,
      expiresAt: Date.now() + 3_600_000,
    });
    if (!unrelatedGrant.ok) throw new Error("unrelated grant setup failed");
    const before = await countRows(setup.t);
    const probes: Array<MutationArgs<typeof jobs.start>> = [
      {
        organizationId: setup.organizationId,
        projectId: setup.projectId,
        text: "Research football transfer rumors",
        operationId: "research.collect",
        kind: "research",
      },
      {
        organizationId: setup.organizationId,
        projectId: setup.projectId,
        text: "Find the weather forecast in Mumbai",
        kind: "research",
      },
      {
        organizationId: setup.organizationId,
        projectId: setup.projectId,
        text: "Research football transfer rumors",
        kind: "research",
        grantId: unrelatedGrant.grantId,
      },
      {
        organizationId: setup.organizationId,
        projectId: setup.projectId,
        text: "Research suppliers and tell me a joke",
        operationId: "research.collect",
        kind: "research",
        grantId: setup.grantId,
      },
    ];
    for (const probe of probes) {
      const result = await setup.asOwner.mutation(startJobRef, probe);
      expect(result.ok).toBe(false);
    }
    expect(await countRows(setup.t)).toEqual(before);
  });

  test("claim rechecks purpose after each unsupported probe is tampered", async () => {
    const unsupportedPayloads = [
      "Research football transfer rumors",
      "Find the weather forecast in Mumbai",
      "Research suppliers and tell me a joke",
    ];
    for (const [index, unsupportedPayload] of unsupportedPayloads.entries()) {
      const setup = await setupResearch();
      const jobId = await startPurchasingJob(setup);
      const reserved = await setup.asOwner.mutation(reserveRef, {
        jobId,
        organizationId: setup.organizationId,
        projectId: setup.projectId,
        amountMicroUsd: 100,
        pricingBasis: "controlled-f1r20r22",
      });
      if (!reserved.ok) throw new Error("reservation setup failed");
      const created = await setup.asOwner.mutation(createOperationRef, {
        jobId,
        organizationId: setup.organizationId,
        projectId: setup.projectId,
        kind: "research.collect",
        requestId: `f1r20-claim-purpose-${index}`,
        payloadJson: JSON.stringify({ query: "Research suppliers for espresso equipment" }),
        grantId: setup.grantId,
        reservationId: reserved.reservationId,
      });
      if (!created.ok) throw new Error("operation setup failed");
      await setup.t.run(async (ctx) => {
        await ctx.db.patch(created.operationId, {
          normalizedPayload: JSON.stringify({ query: unsupportedPayload }),
          normalizedPayloadHash: "tampered",
        });
      });
      const before = await countRows(setup.t);
      const claim = await setup.t.mutation(claimRef, {
        operationId: created.operationId,
        identity: setup.identity.tokenIdentifier,
      });
      expect(claim.ok).toBe(false);
      if (claim.ok) throw new Error("tampered claim unexpectedly succeeded");
      expect(claim.code).toBe("unrelated-refusal");
      expect(await countRows(setup.t)).toEqual({ ...before, attempts: before.attempts });
    }
  });
});

describe("F1R-22 finite admission and cancellation boundaries", () => {
  test("grant job admission is finite and concurrent calls cannot exceed it", async () => {
    const setup = await setupResearch();
    for (let index = 0; index < MAX_JOBS_PER_GRANT - 1; index += 1) {
      await startPurchasingJob(setup, `Research suppliers for espresso equipment branch ${index}`);
    }
    const concurrent = await Promise.all([
      setup.asOwner.mutation(startJobRef, {
        organizationId: setup.organizationId,
        projectId: setup.projectId,
        text: "Research suppliers for espresso equipment branch concurrent-a",
        operationId: "research.collect",
        kind: "research",
        grantId: setup.grantId,
      }),
      setup.asOwner.mutation(startJobRef, {
        organizationId: setup.organizationId,
        projectId: setup.projectId,
        text: "Research suppliers for espresso equipment branch concurrent-b",
        operationId: "research.collect",
        kind: "research",
        grantId: setup.grantId,
      }),
    ]);
    expect(concurrent.filter((result) => result.ok)).toHaveLength(1);
    expect((await countRows(setup.t)).jobs).toBe(MAX_JOBS_PER_GRANT);
  });

  test("reservation admission is finite and retains all accepted exposure", async () => {
    const setup = await setupResearch();
    const jobId = await startPurchasingJob(setup);
    for (let index = 0; index < MAX_RESERVATIONS_PER_JOB; index += 1) {
      const reserved = await setup.asOwner.mutation(reserveRef, {
        jobId,
        organizationId: setup.organizationId,
        projectId: setup.projectId,
        amountMicroUsd: 1,
        pricingBasis: "controlled-f1r20r22",
      });
      expect(reserved.ok).toBe(true);
    }
    const before = await countRows(setup.t);
    const denied = await setup.asOwner.mutation(reserveRef, {
      jobId,
      organizationId: setup.organizationId,
      projectId: setup.projectId,
      amountMicroUsd: 1,
      pricingBasis: "controlled-f1r20r22",
    });
    expect(denied.ok).toBe(false);
    if (denied.ok) throw new Error("reservation admission unexpectedly succeeded");
    expect(denied.code).toBe("reservation-admission-limit");
    expect(await countRows(setup.t)).toEqual(before);
  });

  test("oversized cancellation fences before cleanup and never releases unknown exposure", async () => {
    const setup = await setupResearch();
    const jobId = await startPurchasingJob(setup);
    const budgetId = await setup.t.run(async (ctx) => {
      const budget = await ctx.db
        .query("providerBudgets")
        .withIndex("by_organization", (q) => q.eq("organizationId", setup.organizationId))
        .unique();
      if (budget === null) throw new Error("budget missing");
      return budget._id;
    });
    await setup.t.run(async (ctx) => {
      for (let index = 0; index < MAX_RESERVATIONS_PER_JOB + 1; index += 1) {
        await ctx.db.insert("reservations", {
          organizationId: setup.organizationId,
          jobId,
          budgetId,
          ceilingMicroUsd: 10_000,
          reservedMicroUsd: 1,
          spentMicroUsd: 0,
          unresolvedMicroUsd: 0,
          pricingBasis: "controlled-f1r20r22",
          state: "open",
          updatedAt: Date.now(),
        });
      }
    });
    const denied = await setup.asOwner.mutation(cancelRef, { jobId, reason: "bounded test" });
    expect(denied.ok).toBe(false);
    if (denied.ok) throw new Error("oversized cancellation unexpectedly succeeded");
    expect(denied.code).toBe("cancellation-work-limit");
    const state = await setup.t.run(async (ctx) => {
      const job = await ctx.db.get(jobId);
      const first = await ctx.db.query("reservations").withIndex("by_job", (q) => q.eq("jobId", jobId)).take(1);
      return { jobState: job?.state, reservationState: first[0]?.state, reserved: first[0]?.reservedMicroUsd };
    });
    expect(state).toEqual({ jobState: "queued", reservationState: "open", reserved: 1 });
  });
});
