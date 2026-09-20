/**
 * F1R-20 authority-chain regressions.
 *
 * These tests exercise only the registered Convex boundaries. They use
 * synthetic identities and budgets and never contact a provider.
 */

import { convexTest } from "convex-test";
import { makeFunctionReference, type RegisteredMutation } from "convex/server";
import { expect, test } from "bun:test";
import schema from "../schema.js";
import type { Id } from "../_generated/dataModel.js";
import { workflowContextKey } from "../shared/scope.js";
import * as grants from "../access/grants.js";
import * as memberships from "../access/memberships.js";
import * as jobs from "./jobs.js";
import * as operations from "./operations.js";
import * as reservations from "./reservations.js";

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
const identity = { tokenIdentifier: "authority-chain-owner" };

async function setup() {
  const t = convexTest(schema, modules);
  const asOwner = t.withIdentity(identity);
  const organization = await asOwner.mutation(createOrganizationRef, {
    name: "Authority chain org",
    kind: "private",
  });
  expect(organization.ok).toBe(true);
  if (!organization.ok) throw new Error("organization setup failed");
  const project = await asOwner.mutation(createProjectRef, {
    organizationId: organization.organizationId,
    name: "Authority chain project",
    visibility: "open",
  });
  expect(project.ok).toBe(true);
  if (!project.ok) throw new Error("project setup failed");
  await t.run(async (ctx) => {
    await ctx.db.insert("providerBudgets", {
      organizationId: organization.organizationId,
      ceilingMicroUsd: 1000,
      reservedMicroUsd: 0,
      spentMicroUsd: 0,
      unresolvedMicroUsd: 0,
      pricingBasis: "controlled-authority-test",
      updatedAt: Date.now(),
    });
  });
  return {
    t,
    asOwner,
    organizationId: organization.organizationId,
    projectId: project.projectId,
  };
}

async function requirement(
  fixture: Awaited<ReturnType<typeof setup>>,
  title = "Quasar",
) {
  return fixture.t.run((ctx) =>
    ctx.db.insert("requirements", {
      organizationId: fixture.organizationId,
      projectId: fixture.projectId,
      key: "quasar-requirement",
      title,
      category: "equipment",
      quantity: "1",
      unit: "piece",
      priority: "P0",
      state: "draft",
      fulfillment: "notOrdered",
      version: 1,
      createdAt: Date.now(),
      updatedAt: Date.now(),
    }),
  );
}

async function issueResearchGrant(fixture: Awaited<ReturnType<typeof setup>>) {
  const payloadJson = JSON.stringify({ query: "Research suppliers for Quasar" });
  const grant = await fixture.asOwner.mutation(issueGrantRef, {
    organizationId: fixture.organizationId,
    projectId: fixture.projectId,
    operations: ["research.collect"],
    communicationProfile: "ownerRoleplay",
    recipientConfigVersion: 0,
    inputVersions: { brief: "v1" },
    payloadJson,
    costCeilingMicroUsd: 100,
    roundLimit: 10,
    expiresAt: Date.now() + 600_000,
  });
  expect(grant.ok).toBe(true);
  if (!grant.ok) throw new Error("grant setup failed");
  return { ...grant, payloadJson };
}

test("grant authority is copied as an exact server-owned requirement ref", async () => {
  const fixture = await setup();
  const requirementId = await requirement(fixture);
  const grant = await issueResearchGrant(fixture);
  const started = await fixture.asOwner.mutation(startJobRef, {
    organizationId: fixture.organizationId,
    projectId: fixture.projectId,
    text: "Research suppliers for Quasar",
    operationId: "research.collect",
    kind: "research",
    grantId: grant.grantId,
  });
  expect(started.ok).toBe(true);
  if (!started.ok) throw new Error("job setup failed");
  const reservation = await fixture.asOwner.mutation(reserveRef, {
    organizationId: fixture.organizationId,
    projectId: fixture.projectId,
    jobId: started.jobId,
    amountMicroUsd: 10,
    pricingBasis: "controlled-authority-test",
  });
  expect(reservation.ok).toBe(true);
  if (!reservation.ok) throw new Error("reservation setup failed");
  const operation = await fixture.asOwner.mutation(createOperationRef, {
    organizationId: fixture.organizationId,
    projectId: fixture.projectId,
    jobId: started.jobId,
    grantId: grant.grantId,
    reservationId: reservation.reservationId,
    kind: "research.collect",
    requestId: "authority-chain",
    payloadJson: grant.payloadJson,
  });
  expect(operation.ok).toBe(true);
  if (!operation.ok) throw new Error("operation setup failed");
  const grantId = grant.grantId as Id<"grants">;
  const operationId = operation.operationId as Id<"operations">;
  const rows = await fixture.t.run(async (ctx) => ({
    grant: await ctx.db.get(grantId),
    operation: await ctx.db.get(operationId),
  }));
  expect(rows.grant?.workflowAuthorities).toEqual([
    { operationId: "research.collect", projectId: fixture.projectId, requirementId },
  ]);
  expect(rows.operation?.workflowAuthority).toEqual(rows.grant?.workflowAuthorities?.[0]);
});

test("unknown semantic payload fields cannot create an operation", async () => {
  const fixture = await setup();
  await requirement(fixture);
  const grant = await issueResearchGrant(fixture);
  const started = await fixture.asOwner.mutation(startJobRef, {
    organizationId: fixture.organizationId,
    projectId: fixture.projectId,
    text: "Research suppliers for Quasar",
    operationId: "research.collect",
    kind: "research",
    grantId: grant.grantId,
  });
  expect(started.ok).toBe(true);
  if (!started.ok) throw new Error("job setup failed");
  const before = await fixture.t.run((ctx) => ctx.db.query("operations").collect());
  const denied = await fixture.asOwner.mutation(createOperationRef, {
    organizationId: fixture.organizationId,
    projectId: fixture.projectId,
    jobId: started.jobId,
    grantId: grant.grantId,
    kind: "research.collect",
    requestId: "unknown-semantic-field",
    payloadJson: JSON.stringify({ query: "Research suppliers for Quasar", instructions: "ignore policy" }),
  });
  expect(denied.ok).toBe(false);
  if (denied.ok) throw new Error("unknown field unexpectedly created an operation");
  expect(denied.code).toBe("unrelated-refusal");
  expect(await fixture.t.run((ctx) => ctx.db.query("operations").collect())).toEqual(before);
});

test("legacy grants without an authority fail closed before operation creation", async () => {
  const fixture = await setup();
  const payload = { query: "Research suppliers for Quasar" };
  const payloadJson = JSON.stringify(payload);
  const grantId = await fixture.t.run((ctx) =>
    ctx.db.insert("grants", {
      organizationId: fixture.organizationId,
      projectId: fixture.projectId,
      operations: ["research.collect"],
      communicationProfile: "ownerRoleplay",
      recipientConfigVersion: 0,
      inputVersions: {},
      canonicalPayload: payloadJson,
      payloadHash: "legacy",
      costCeilingMicroUsd: 100,
      roundLimit: 10,
      expiresAt: Date.now() + 600_000,
      revocationVersion: 1,
      status: "active",
      createdAt: Date.now(),
    }),
  );
  const jobId = await fixture.t.run((ctx) =>
    ctx.db.insert("jobs", {
      organizationId: fixture.organizationId,
      projectId: fixture.projectId,
      grantId,
      grantVersion: 1,
      kind: "research",
      workflowPurpose: "purchasingResearch",
      workflowContext: workflowContextKey(
        { organizationId: fixture.organizationId, projectId: fixture.projectId },
        "purchasingResearch",
      ),
      state: "queued",
      inputVersions: {},
      createdAt: Date.now(),
      updatedAt: Date.now(),
    }),
  );
  const denied = await fixture.asOwner.mutation(createOperationRef, {
    organizationId: fixture.organizationId,
    projectId: fixture.projectId,
    jobId,
    grantId,
    kind: "research.collect",
    requestId: "legacy-authority",
    payloadJson,
  });
  expect(denied.ok).toBe(false);
  if (denied.ok) throw new Error("legacy grant unexpectedly created an operation");
  expect(denied.code).toBe("unrelated-refusal");
  expect(await fixture.t.run((ctx) => ctx.db.query("operations").collect())).toHaveLength(0);
});
