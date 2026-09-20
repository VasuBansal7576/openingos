/**
 * F1R-20/F1R-24 job authority-chain regressions.
 *
 * These tests exercise the registered start boundary with synthetic records;
 * no provider operation is contacted.
 */

import { convexTest } from "convex-test";
import { makeFunctionReference, type RegisteredMutation } from "convex/server";
import { expect, test } from "bun:test";
import schema from "../schema.js";
import type { Id } from "../_generated/dataModel.js";
import * as grants from "../access/grants.js";
import * as memberships from "../access/memberships.js";
import * as jobs from "./jobs.js";
import * as operations from "./operations.js";
import * as reservations from "./reservations.js";
import type { WorkflowAuthority } from "../shared/scope.js";

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

const identity = { tokenIdentifier: "jobs-authority-chain-owner" };

async function setup() {
  const t = convexTest(schema, modules);
  const asOwner = t.withIdentity(identity);
  const organization = await asOwner.mutation(createOrganizationRef, {
    name: "Job authority chain org",
    kind: "private",
  });
  expect(organization.ok).toBe(true);
  if (!organization.ok) throw new Error("organization setup failed");
  const project = await asOwner.mutation(createProjectRef, {
    organizationId: organization.organizationId,
    name: "Job authority chain project",
    visibility: "open",
  });
  expect(project.ok).toBe(true);
  if (!project.ok) throw new Error("project setup failed");
  await t.run((ctx) =>
    ctx.db.insert("providerBudgets", {
      organizationId: organization.organizationId,
      ceilingMicroUsd: 1_000,
      reservedMicroUsd: 0,
      spentMicroUsd: 0,
      unresolvedMicroUsd: 0,
      pricingBasis: "controlled-job-authority-chain",
      updatedAt: Date.now(),
    }),
  );
  return {
    t,
    asOwner,
    organizationId: organization.organizationId,
    projectId: project.projectId,
  };
}

async function insertRequirement(
  fixture: Awaited<ReturnType<typeof setup>>,
  title: string,
  state: "draft" | "cancelled" = "draft",
): Promise<Id<"requirements">> {
  return fixture.t.run((ctx) =>
    ctx.db.insert("requirements", {
      organizationId: fixture.organizationId,
      projectId: fixture.projectId,
      key: `${title.toLocaleLowerCase()}-requirement`,
      title,
      category: "equipment",
      quantity: "1",
      unit: "piece",
      priority: "P0",
      state,
      fulfillment: "notOrdered",
      version: 1,
      createdAt: Date.now(),
      updatedAt: Date.now(),
    }),
  );
}

async function issueResearchGrant(
  fixture: Awaited<ReturnType<typeof setup>>,
  workflowAuthorities: WorkflowAuthority[],
) {
  const grant = await fixture.asOwner.mutation(issueGrantRef, {
    organizationId: fixture.organizationId,
    projectId: fixture.projectId,
    operations: ["research.collect", "comparison.read"],
    communicationProfile: "ownerRoleplay",
    recipientConfigVersion: 0,
    inputVersions: { brief: "v1" },
    payloadJson: JSON.stringify({ query: "Research suppliers for Quasar" }),
    costCeilingMicroUsd: 100,
    roundLimit: 10,
    expiresAt: Date.now() + 600_000,
    workflowAuthorities,
  });
  expect(grant.ok).toBe(true);
  if (!grant.ok) throw new Error("grant setup failed");
  return grant.grantId;
}

async function rowCounts(fixture: Awaited<ReturnType<typeof setup>>) {
  return fixture.t.run(async (ctx) => ({
    grants: (await ctx.db.query("grants").collect()).length,
    jobs: (await ctx.db.query("jobs").collect()).length,
    operations: (await ctx.db.query("operations").collect()).length,
    reservations: (await ctx.db.query("reservations").collect()).length,
  }));
}

type SeedGrant = {
  readonly organizationId: Id<"organizations">;
  readonly projectId: Id<"projects">;
  readonly operations: string[];
  readonly communicationProfile: string;
  readonly recipientConfigVersion: number;
  readonly inputVersions: Record<string, string>;
  readonly canonicalPayload: string;
  readonly payloadHash: string;
  readonly costCeilingMicroUsd: number;
  readonly roundLimit: number;
  readonly expiresAt: number;
  readonly revocationVersion: number;
  readonly status: "active" | "revoked" | "expired";
  readonly createdAt: number;
  readonly workflowAuthorities?: WorkflowAuthority[];
};

test("start copies the selected operation authority through the job to the operation", async () => {
  const fixture = await setup();
  const requirementId = await insertRequirement(fixture, "Quasar");
  const authorities: WorkflowAuthority[] = [
    { operationId: "research.collect", projectId: fixture.projectId, requirementId },
    { operationId: "comparison.read", projectId: fixture.projectId, requirementId },
  ];
  const grantId = await issueResearchGrant(fixture, authorities);
  const started = await fixture.asOwner.mutation(startJobRef, {
    organizationId: fixture.organizationId,
    projectId: fixture.projectId,
    text: "Research suppliers for Quasar",
    operationId: "research.collect",
    kind: "research",
    grantId,
  });
  expect(started.ok).toBe(true);
  if (!started.ok) throw new Error("job setup failed");

  const reservation = await fixture.asOwner.mutation(reserveRef, {
    organizationId: fixture.organizationId,
    projectId: fixture.projectId,
    jobId: started.jobId,
    amountMicroUsd: 10,
    pricingBasis: "controlled-job-authority-chain",
  });
  expect(reservation.ok).toBe(true);
  if (!reservation.ok) throw new Error("reservation setup failed");
  const operation = await fixture.asOwner.mutation(createOperationRef, {
    organizationId: fixture.organizationId,
    projectId: fixture.projectId,
    jobId: started.jobId,
    grantId,
    reservationId: reservation.reservationId,
    kind: "research.collect",
    requestId: "job-authority-chain",
    payloadJson: JSON.stringify({ query: "Research suppliers for Quasar" }),
  });
  expect(operation.ok).toBe(true);
  if (!operation.ok) throw new Error("operation setup failed");

  const rows = await fixture.t.run(async (ctx) => ({
    grant: await ctx.db.get(grantId),
    job: await ctx.db.get(started.jobId),
    operation: await ctx.db.get(operation.operationId),
  }));
  const selected = authorities[0];
  expect(selected).toBeDefined();
  expect(rows.grant?.workflowAuthorities).toEqual(authorities);
  expect(rows.job?.workflowAuthority).toEqual(selected);
  expect(rows.operation?.workflowAuthority).toEqual(selected);
});

test("supplied grant text cannot pivot away from its bound requirement", async () => {
  const fixture = await setup();
  const boundRequirementId = await insertRequirement(fixture, "Quasar");
  await insertRequirement(fixture, "Espresso");
  const grantId = await issueResearchGrant(fixture, [
    { operationId: "research.collect", projectId: fixture.projectId, requirementId: boundRequirementId },
    { operationId: "comparison.read", projectId: fixture.projectId, requirementId: boundRequirementId },
  ]);
  const before = await rowCounts(fixture);
  const denied = await fixture.asOwner.mutation(startJobRef, {
    organizationId: fixture.organizationId,
    projectId: fixture.projectId,
    text: "What changes for Espresso?",
    operationId: "research.collect",
    kind: "research",
    grantId,
  });
  expect(denied.ok).toBe(false);
  if (denied.ok) throw new Error("text pivot unexpectedly created a job");
  expect(denied.code).toBe("unrelated-refusal");
  expect(await rowCounts(fixture)).toEqual(before);
});

test("automatic research creates exact query payload and operation authority", async () => {
  const fixture = await setup();
  const text = "Research suppliers for the espresso machine";
  const started = await fixture.asOwner.mutation(startJobRef, {
    organizationId: fixture.organizationId,
    projectId: fixture.projectId,
    text,
    kind: "research",
  });
  expect(started.ok).toBe(true);
  if (!started.ok) throw new Error("automatic job setup failed");

  const rows = await fixture.t.run(async (ctx) => {
    const job = await ctx.db.get(started.jobId);
    return { job, grant: job === null ? null : await ctx.db.get(job.grantId) };
  });
  expect(rows.grant?.canonicalPayload).toBe(JSON.stringify({ query: text }));
  expect(rows.grant?.workflowAuthorities).toEqual([
    { operationId: "research.collect", projectId: fixture.projectId },
  ]);
  expect(rows.job?.workflowAuthority).toEqual(rows.grant?.workflowAuthorities?.[0]);
});

test("missing, stale, foreign, cancelled, mismatched, and ambiguous authority create no job", async () => {
  const fixture = await setup();
  const cancelledRequirementId = await insertRequirement(fixture, "Cancelled", "cancelled");
  const foreignProject = await fixture.asOwner.mutation(createProjectRef, {
    organizationId: fixture.organizationId,
    name: "Foreign authority project",
    visibility: "open",
  });
  expect(foreignProject.ok).toBe(true);
  if (!foreignProject.ok) throw new Error("foreign project setup failed");

  const payload = JSON.stringify({ query: "Research suppliers for Quasar" });
  const base: SeedGrant = {
    organizationId: fixture.organizationId,
    projectId: fixture.projectId,
    operations: ["research.collect", "comparison.read"],
    communicationProfile: "ownerRoleplay",
    recipientConfigVersion: 0,
    inputVersions: {},
    canonicalPayload: payload,
    payloadHash: "controlled-job-authority-chain",
    costCeilingMicroUsd: 100,
    roundLimit: 3,
    expiresAt: Date.now() + 600_000,
    revocationVersion: 1,
    status: "active",
    createdAt: Date.now(),
  };
  const malformed: Array<{ readonly label: string; readonly grant: SeedGrant }> = [
    { label: "missing", grant: base },
    {
      label: "stale",
      grant: { ...base, status: "revoked" as const },
    },
    {
      label: "expired",
      grant: { ...base, expiresAt: Date.now() - 1 },
    },
    {
      label: "foreign",
      grant: {
        ...base,
        projectId: foreignProject.projectId,
        workflowAuthorities: [{ operationId: "research.collect", projectId: foreignProject.projectId }],
      },
    },
    {
      label: "cancelled",
      grant: {
        ...base,
        workflowAuthorities: [{ operationId: "research.collect", projectId: fixture.projectId, requirementId: cancelledRequirementId }],
      },
    },
    {
      label: "mismatched",
      grant: {
        ...base,
        workflowAuthorities: [{ operationId: "comparison.read", projectId: fixture.projectId }],
      },
    },
    {
      label: "ambiguous",
      grant: {
        ...base,
        workflowAuthorities: [
          { operationId: "research.collect", projectId: fixture.projectId },
          { operationId: "research.collect", projectId: fixture.projectId },
        ],
      },
    },
  ];

  for (const candidate of malformed) {
    const grantId = await fixture.t.run((ctx) => ctx.db.insert("grants", candidate.grant));
    const before = await rowCounts(fixture);
    const denied = await fixture.asOwner.mutation(startJobRef, {
      organizationId: fixture.organizationId,
      projectId: fixture.projectId,
      text: "Research suppliers for Quasar",
      operationId: "research.collect",
      kind: "research",
      grantId,
    });
    expect(denied.ok, candidate.label).toBe(false);
    expect(await rowCounts(fixture), candidate.label).toEqual(before);
  }
});
