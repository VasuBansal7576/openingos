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
const claimOperationRef = makeFunctionReference<
  "mutation",
  MutationArgs<typeof operations.claim>,
  MutationReturn<typeof operations.claim>
>("execution/operations:claim");

const identity = { tokenIdentifier: "jobs-authority-chain-owner" };

const genericReadPrompts = [
  "evidence",
  "quotes",
  "supplier",
  "Show the current stock",
  "Show the current budget",
  "Show the current order",
  "Show the current terms",
  "Show the current price",
  "Show the current cost",
  "Show the current delivery",
  "Show the current warranty",
  "Show the current payment",
  "Show the current availability",
  "Show the current freight",
  "Show the current savings",
  "Show the current spend",
] as const;

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
  query = "Research suppliers for Quasar",
) {
  const grant = await fixture.asOwner.mutation(issueGrantRef, {
    organizationId: fixture.organizationId,
    projectId: fixture.projectId,
    operations: ["research.collect", "comparison.read"],
    communicationProfile: "ownerRoleplay",
    recipientConfigVersion: 0,
    inputVersions: { brief: "v1" },
    payloadJson: JSON.stringify({ query }),
    costCeilingMicroUsd: 100,
    roundLimit: 10,
    expiresAt: Date.now() + 600_000,
    workflowAuthorities,
  });
  expect(grant.ok).toBe(true);
  if (!grant.ok) throw new Error("grant setup failed");
  return grant.grantId;
}

async function issueReadGrant(
  fixture: Awaited<ReturnType<typeof setup>>,
  operationId: "research.read" | "comparison.read",
  query = "Show the current supplier quotes",
) {
  const authority: WorkflowAuthority = { operationId, projectId: fixture.projectId };
  const grant = await fixture.asOwner.mutation(issueGrantRef, {
    organizationId: fixture.organizationId,
    projectId: fixture.projectId,
    operations: [operationId],
    communicationProfile: "ownerRoleplay",
    recipientConfigVersion: 0,
    inputVersions: { brief: "v1" },
    payloadJson: JSON.stringify({ query }),
    costCeilingMicroUsd: 100,
    roundLimit: 10,
    expiresAt: Date.now() + 600_000,
    workflowAuthorities: [authority],
  });
  expect(grant.ok).toBe(true);
  if (!grant.ok) throw new Error(`${operationId} grant setup failed`);
  return grant.grantId;
}

async function rowCounts(fixture: Awaited<ReturnType<typeof setup>>) {
  return fixture.t.run(async (ctx) => ({
    grants: (await ctx.db.query("grants").collect()).length,
    jobs: (await ctx.db.query("jobs").collect()).length,
    operations: (await ctx.db.query("operations").collect()).length,
    reservations: (await ctx.db.query("reservations").collect()).length,
    attempts: (await ctx.db.query("attempts").collect()).length,
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

test("supplied grant rejects an anchored text pivot from its bound requirement", async () => {
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
    text: "Research suppliers for Espresso",
    operationId: "research.collect",
    kind: "research",
    grantId,
  });
  expect(denied.ok).toBe(false);
  if (denied.ok) throw new Error("text pivot unexpectedly created a job");
  expect(denied.code).toBe("unrelated-refusal");
  expect(await rowCounts(fixture)).toEqual(before);
});

test("supplied grant preserves anaphoric text under its exact requirement authority", async () => {
  const fixture = await setup();
  const boundRequirementId = await insertRequirement(fixture, "Quasar");
  const text = "What changes if they choose another option?";
  const grantId = await issueResearchGrant(
    fixture,
    [
      { operationId: "research.collect", projectId: fixture.projectId, requirementId: boundRequirementId },
      { operationId: "comparison.read", projectId: fixture.projectId, requirementId: boundRequirementId },
    ],
    text,
  );
  const started = await fixture.asOwner.mutation(startJobRef, {
    organizationId: fixture.organizationId,
    projectId: fixture.projectId,
    text,
    operationId: "research.collect",
    kind: "research",
    grantId,
  });
  expect(started.ok).toBe(true);
  if (!started.ok) throw new Error("anaphoric job setup failed");
  const job = await fixture.t.run((ctx) => ctx.db.get(started.jobId));
  expect(job?.workflowAuthority).toEqual({
    operationId: "research.collect",
    projectId: fixture.projectId,
    requirementId: boundRequirementId,
  });
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
  expect(rows.grant?.status).toBe("active");
  expect(rows.grant?.costCeilingMicroUsd).toBe(0);
  expect(rows.grant?.workflowAuthorities).toEqual([
    { operationId: "research.collect", projectId: fixture.projectId },
  ]);
  expect(rows.job?.workflowAuthority).toEqual(rows.grant?.workflowAuthorities?.[0]);
  expect(await rowCounts(fixture)).toMatchObject({ grants: 1, jobs: 1, operations: 0 });
});

test("automatic research reads refuse an unrelated explanation before any durable row", async () => {
  const fixture = await setup();
  const text = "Explain how a Turing machine solves the halting problem";
  const before = await rowCounts(fixture);

  for (const operationId of ["research.read", "comparison.read"] as const) {
    const denied = await fixture.asOwner.mutation(startJobRef, {
      organizationId: fixture.organizationId,
      projectId: fixture.projectId,
      text,
      operationId,
      kind: "research",
    });
    expect(denied.ok, operationId).toBe(false);
    if (denied.ok) throw new Error(`${operationId} unexpectedly accepted an unrelated request`);
    expect(denied.code, operationId).toBe("unrelated-refusal");
    expect(await rowCounts(fixture), operationId).toEqual(before);
  }
});

test("automatic research reads refuse generic commercial nouns before any durable row", async () => {
  const fixture = await setup();

  for (const operationId of ["research.read", "comparison.read"] as const) {
    for (const text of genericReadPrompts) {
      const before = await rowCounts(fixture);
      const denied = await fixture.asOwner.mutation(startJobRef, {
        organizationId: fixture.organizationId,
        projectId: fixture.projectId,
        text,
        operationId,
        kind: "research",
      });
      expect(denied.ok, `${operationId}: ${text}`).toBe(false);
      if (denied.ok) throw new Error(`${operationId} unexpectedly accepted ${text}`);
      expect(denied.code, `${operationId}: ${text}`).toBe("unrelated-refusal");
      expect(await rowCounts(fixture), `${operationId}: ${text}`).toEqual(before);
    }
  }
});

test("generic commercial nouns cannot bind an existing read grant operation", async () => {
  for (const operationId of ["research.read", "comparison.read"] as const) {
    const fixture = await setup();
    const grantId = await issueReadGrant(fixture, operationId);
    const text = "Show the current supplier quotes";
    const started = await fixture.asOwner.mutation(startJobRef, {
      organizationId: fixture.organizationId,
      projectId: fixture.projectId,
      text,
      operationId,
      kind: "research",
      grantId,
    });
    expect(started.ok, operationId).toBe(true);
    if (!started.ok) throw new Error(`${operationId} read job setup failed`);

    const before = await rowCounts(fixture);
    for (const [index, query] of genericReadPrompts.entries()) {
      const denied = await fixture.asOwner.mutation(createOperationRef, {
        organizationId: fixture.organizationId,
        projectId: fixture.projectId,
        jobId: started.jobId,
        grantId,
        kind: operationId,
        requestId: `generic-${operationId}-${index}`,
        payloadJson: JSON.stringify({ query }),
      });
      expect(denied.ok, `${operationId}: ${query}`).toBe(false);
      if (denied.ok) throw new Error(`${operationId} created an unrelated operation for ${query}`);
      expect(denied.code, `${operationId}: ${query}`).toBe("unrelated-refusal");
      expect(await rowCounts(fixture), `${operationId}: ${query}`).toEqual(before);
    }

    const operations = await fixture.t.run((ctx) => ctx.db.query("operations").collect());
    expect(operations, operationId).toHaveLength(0);
  }
});

test("lone read-record nouns cannot reach claim or create an attempt", async () => {
  for (const operationId of ["research.read", "comparison.read"] as const) {
    const fixture = await setup();
    const grantId = await issueReadGrant(fixture, operationId);
    const started = await fixture.asOwner.mutation(startJobRef, {
      organizationId: fixture.organizationId,
      projectId: fixture.projectId,
      text: "Show the current supplier quotes",
      operationId,
      kind: "research",
      grantId,
    });
    expect(started.ok, operationId).toBe(true);
    if (!started.ok) throw new Error(`${operationId} read job setup failed`);

    for (const [index, query] of ["evidence", "quotes", "supplier"].entries()) {
      const created = await fixture.asOwner.mutation(createOperationRef, {
        organizationId: fixture.organizationId,
        projectId: fixture.projectId,
        jobId: started.jobId,
        grantId,
        kind: operationId,
        requestId: `claim-lone-noun-${operationId}-${index}`,
        payloadJson: JSON.stringify({ query: "Show the current supplier quotes" }),
      });
      expect(created.ok, `${operationId}: ${query}`).toBe(true);
      if (!created.ok) throw new Error(`${operationId} operation setup failed`);

      // Simulate a stale or tampered payload reaching the internal claim
      // boundary after operation creation; claim must re-run the read grammar.
      await fixture.t.run(async (ctx) => {
        await ctx.db.patch(created.operationId, {
          normalizedPayload: JSON.stringify({ query }),
        });
        await ctx.db.patch(grantId, {
          canonicalPayload: JSON.stringify({ query }),
        });
      });
      const beforeClaim = await rowCounts(fixture);
      const claimed = await fixture.t.mutation(claimOperationRef, {
        operationId: created.operationId,
        identity: identity.tokenIdentifier,
      });
      expect(claimed.ok, `${operationId}: ${query}`).toBe(false);
      expect(await rowCounts(fixture), `${operationId}: ${query}`).toEqual(beforeClaim);
      const operation = await fixture.t.run((ctx) => ctx.db.get(created.operationId));
      expect(operation?.state, `${operationId}: ${query}`).toBe("prepared");
      await fixture.t.run((ctx) =>
        ctx.db.patch(grantId, {
          canonicalPayload: JSON.stringify({ query: "Show the current supplier quotes" }),
        }),
      );
    }
  }
});

test("read routes preserve contextual purchasing questions and automatic supplier research", async () => {
  const fixture = await setup();
  await insertRequirement(fixture, "Quasar");

  const readRoutes = [
    ["research.read", "What changes if they choose another option for Quasar?"],
    ["comparison.read", "Compare the current quotes for Quasar."],
  ] as const;
  for (const [operationId, text] of readRoutes) {
    const started = await fixture.asOwner.mutation(startJobRef, {
      organizationId: fixture.organizationId,
      projectId: fixture.projectId,
      text,
      operationId,
      kind: "research",
    });
    expect(started.ok, operationId).toBe(true);
    if (!started.ok) throw new Error(`${operationId} setup failed`);
    const grantId = await fixture.t.run(async (ctx) => {
      const job = await ctx.db.get(started.jobId);
      if (job === null) throw new Error("job row missing");
      return job.grantId;
    });
    const beforeUnrelatedCreate = await rowCounts(fixture);
    const unrelatedCreate = await fixture.asOwner.mutation(createOperationRef, {
      organizationId: fixture.organizationId,
      projectId: fixture.projectId,
      jobId: started.jobId,
      grantId,
      kind: operationId,
      requestId: `unrelated-${operationId}`,
      payloadJson: JSON.stringify({
        query: "Explain how a Turing machine solves the halting problem",
      }),
    });
    expect(unrelatedCreate.ok, operationId).toBe(false);
    if (unrelatedCreate.ok) throw new Error(`${operationId} created an unrelated operation`);
    expect(unrelatedCreate.code, operationId).toBe("unrelated-refusal");
    expect(await rowCounts(fixture), operationId).toEqual(beforeUnrelatedCreate);

    const created = await fixture.asOwner.mutation(createOperationRef, {
      organizationId: fixture.organizationId,
      projectId: fixture.projectId,
      jobId: started.jobId,
      grantId,
      kind: operationId,
      requestId: `contextual-${operationId}`,
      payloadJson: JSON.stringify({ query: text }),
    });
    expect(created.ok, operationId).toBe(true);
    if (!created.ok) throw new Error(`${operationId} operation setup failed`);
    const claimed = await fixture.t.mutation(claimOperationRef, {
      operationId: created.operationId,
      identity: identity.tokenIdentifier,
    });
    expect(claimed.ok, operationId).toBe(true);
  }

  const collected = await fixture.asOwner.mutation(startJobRef, {
    organizationId: fixture.organizationId,
    projectId: fixture.projectId,
    text: "Research suppliers for the Mazzer Super Jolly grinder",
    kind: "research",
  });
  expect(collected.ok).toBe(true);
});

test("automatic record-changing operation IDs create no grant, job, or operation", async () => {
  const fixture = await setup();
  for (const operationId of ["evidence.record", "quote.record"]) {
    const before = await rowCounts(fixture);
    const denied = await fixture.asOwner.mutation(startJobRef, {
      organizationId: fixture.organizationId,
      projectId: fixture.projectId,
      text: "Research suppliers for the espresso machine",
      operationId,
      kind: "research",
    });
    expect(denied.ok, operationId).toBe(false);
    if (denied.ok) throw new Error(`${operationId} unexpectedly received automatic authority`);
    expect(denied.code, operationId).toBe("denied-capability");
    expect(await rowCounts(fixture), operationId).toEqual(before);
  }
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
