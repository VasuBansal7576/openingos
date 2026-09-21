/**
 * E3 server-side automatic-start idempotency regressions.
 *
 * Two separate clients (or concurrent calls) representing the same logical
 * automatic research start must create exactly one automatic grant and one
 * queued job. Client-side pending state is insufficient because separate
 * clients never share it, so the `start` handler binds a bounded
 * caller-supplied key to the server-derived material fingerprint (project,
 * operation, kind, requirement authority, normalized supported payload).
 *
 * These tests exercise the registered start boundary with synthetic records;
 * no provider operation is contacted. All evidence is controlled and
 * owner-only.
 */

import { convexTest } from "convex-test";
import { makeFunctionReference, type RegisteredMutation } from "convex/server";
import { expect, test } from "bun:test";
import schema from "../schema.js";
import * as memberships from "../access/memberships.js";
import * as grants from "../access/grants.js";
import * as jobs from "./jobs.js";

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
const startJobRef = makeFunctionReference<
  "mutation",
  MutationArgs<typeof jobs.start>,
  MutationReturn<typeof jobs.start>
>("execution/jobs:start");
const issueGrantRef = makeFunctionReference<
  "mutation",
  MutationArgs<typeof grants.issue>,
  MutationReturn<typeof grants.issue>
>("access/grants:issue");

const identity = { tokenIdentifier: "jobs-idempotency-owner" };

const COLLECT_TEXT = "Research suppliers for the espresso machine";
const CHANGED_COLLECT_TEXT = "Research vendors for the espresso grinder";
const READ_TEXT = "Show the current supplier quotes";

async function setup() {
  const t = convexTest(schema, modules);
  const asOwner = t.withIdentity(identity);
  const organization = await asOwner.mutation(createOrganizationRef, {
    name: "Job idempotency org",
    kind: "private",
  });
  expect(organization.ok).toBe(true);
  if (!organization.ok) throw new Error("organization setup failed");
  const project = await asOwner.mutation(createProjectRef, {
    organizationId: organization.organizationId,
    name: "Job idempotency project",
    visibility: "open",
  });
  expect(project.ok).toBe(true);
  if (!project.ok) throw new Error("project setup failed");
  return {
    t,
    asOwner,
    organizationId: organization.organizationId,
    projectId: project.projectId,
  };
}

async function rowCounts(fixture: Awaited<ReturnType<typeof setup>>) {
  return fixture.t.run(async (ctx) => ({
    grants: (await ctx.db.query("grants").collect()).length,
    jobs: (await ctx.db.query("jobs").collect()).length,
    operations: (await ctx.db.query("operations").collect()).length,
  }));
}

test("sequential exact replay returns the original job with one grant and one job", async () => {
  const fixture = await setup();
  const first = await fixture.asOwner.mutation(startJobRef, {
    organizationId: fixture.organizationId,
    projectId: fixture.projectId,
    text: COLLECT_TEXT,
    kind: "research",
    idempotencyKey: "e3-sequential-replay-01",
  });
  expect(first.ok).toBe(true);
  if (!first.ok) throw new Error("first start failed");
  expect(await rowCounts(fixture)).toEqual({ grants: 1, jobs: 1, operations: 0 });

  // A second client representing the same logical start replays the same
  // key and text: the server returns the original job with no second grant.
  const second = await fixture.asOwner.mutation(startJobRef, {
    organizationId: fixture.organizationId,
    projectId: fixture.projectId,
    text: COLLECT_TEXT,
    kind: "research",
    idempotencyKey: "e3-sequential-replay-01",
  });
  expect(second.ok).toBe(true);
  if (!second.ok) throw new Error("replay unexpectedly failed");
  expect(second.jobId).toBe(first.jobId);
  expect(second.state).toBe(first.state);
  expect(second.supportedSegment).toBe(first.supportedSegment);
  expect(await rowCounts(fixture)).toEqual({ grants: 1, jobs: 1, operations: 0 });
});

test("concurrent Promise.all replays create exactly one grant and one job", async () => {
  const fixture = await setup();
  // Promise.all submits both top-level mutations without awaiting either
  // winner. convex-test serializes those mutations at the same boundary as
  // Convex, so the second transaction observes the first commit and replays
  // it instead of inserting a second grant/job pair.
  const [left, right] = await Promise.all([
    fixture.asOwner.mutation(startJobRef, {
      organizationId: fixture.organizationId,
      projectId: fixture.projectId,
      text: COLLECT_TEXT,
      kind: "research",
      idempotencyKey: "e3-concurrent-replay-01",
    }),
    fixture.asOwner.mutation(startJobRef, {
      organizationId: fixture.organizationId,
      projectId: fixture.projectId,
      text: COLLECT_TEXT,
      kind: "research",
      idempotencyKey: "e3-concurrent-replay-01",
    }),
  ]);
  expect(left.ok).toBe(true);
  expect(right.ok).toBe(true);
  if (!left.ok || !right.ok) throw new Error("concurrent replay failed");
  expect(left.jobId).toBe(right.jobId);
  expect(await rowCounts(fixture)).toEqual({ grants: 1, jobs: 1, operations: 0 });
});

test("same key with a changed normalized payload conflicts without a new grant or job", async () => {
  const fixture = await setup();
  const first = await fixture.asOwner.mutation(startJobRef, {
    organizationId: fixture.organizationId,
    projectId: fixture.projectId,
    text: COLLECT_TEXT,
    kind: "research",
    idempotencyKey: "e3-changed-payload-01",
  });
  expect(first.ok).toBe(true);
  if (!first.ok) throw new Error("first start failed");
  const before = await rowCounts(fixture);

  const conflicted = await fixture.asOwner.mutation(startJobRef, {
    organizationId: fixture.organizationId,
    projectId: fixture.projectId,
    text: CHANGED_COLLECT_TEXT,
    kind: "research",
    idempotencyKey: "e3-changed-payload-01",
  });
  expect(conflicted.ok).toBe(false);
  if (conflicted.ok) throw new Error("changed payload unexpectedly replayed");
  expect(conflicted.code).toBe("duplicate-conflict");
  expect(await rowCounts(fixture)).toEqual(before);
});

test("same key with a different operation or kind fails closed without a new effect", async () => {
  const fixture = await setup();
  const first = await fixture.asOwner.mutation(startJobRef, {
    organizationId: fixture.organizationId,
    projectId: fixture.projectId,
    text: COLLECT_TEXT,
    kind: "research",
    idempotencyKey: "e3-changed-operation-01",
  });
  expect(first.ok).toBe(true);
  if (!first.ok) throw new Error("first start failed");
  const before = await rowCounts(fixture);

  // Different operation under the same key: the stored research.collect
  // authority does not match the requested comparison.read authority.
  const operationConflict = await fixture.asOwner.mutation(startJobRef, {
    organizationId: fixture.organizationId,
    projectId: fixture.projectId,
    text: READ_TEXT,
    operationId: "comparison.read",
    kind: "research",
    idempotencyKey: "e3-changed-operation-01",
  });
  expect(operationConflict.ok).toBe(false);
  if (operationConflict.ok) throw new Error("changed operation unexpectedly replayed");
  expect(operationConflict.code).toBe("duplicate-conflict");
  expect(await rowCounts(fixture)).toEqual(before);

  // Different kind under the same key never reaches the idempotency probe:
  // the kind gate denies before any grant or job write.
  const kindDenied = await fixture.asOwner.mutation(startJobRef, {
    organizationId: fixture.organizationId,
    projectId: fixture.projectId,
    text: COLLECT_TEXT,
    kind: "communication",
    idempotencyKey: "e3-changed-operation-01",
  });
  expect(kindDenied.ok).toBe(false);
  if (kindDenied.ok) throw new Error("changed kind unexpectedly started");
  expect(await rowCounts(fixture)).toEqual(before);
});

test("same key in another project never replays the foreign job", async () => {
  const fixture = await setup();
  const first = await fixture.asOwner.mutation(startJobRef, {
    organizationId: fixture.organizationId,
    projectId: fixture.projectId,
    text: COLLECT_TEXT,
    kind: "research",
    idempotencyKey: "e3-cross-project-01",
  });
  expect(first.ok).toBe(true);
  if (!first.ok) throw new Error("first start failed");

  const otherProject = await fixture.asOwner.mutation(createProjectRef, {
    organizationId: fixture.organizationId,
    name: "Job idempotency other project",
    visibility: "open",
  });
  expect(otherProject.ok).toBe(true);
  if (!otherProject.ok) throw new Error("other project setup failed");

  // The compound project index scopes the probe to the supplied project, so
  // the foreign job is never returned and its existence does not leak: the
  // caller receives only a job bound to the project it asked about.
  const other = await fixture.asOwner.mutation(startJobRef, {
    organizationId: fixture.organizationId,
    projectId: otherProject.projectId,
    text: COLLECT_TEXT,
    kind: "research",
    idempotencyKey: "e3-cross-project-01",
  });
  expect(other.ok).toBe(true);
  if (!other.ok) throw new Error("other-project start failed");
  expect(other.jobId).not.toBe(first.jobId);

  const rows = await fixture.t.run(async (ctx) => ({
    firstJob: await ctx.db.get(first.jobId),
    otherJob: await ctx.db.get(other.jobId),
  }));
  expect(rows.firstJob?.projectId).toBe(fixture.projectId);
  expect(rows.otherJob?.projectId).toBe(otherProject.projectId);
  expect(rows.otherJob?.grantId).not.toBe(rows.firstJob?.grantId);
  expect(await rowCounts(fixture)).toEqual({ grants: 2, jobs: 2, operations: 0 });
});

test("invalid keys and key-plus-supplied-grant fail closed before any write", async () => {
  const fixture = await setup();
  const before = await rowCounts(fixture);
  for (const idempotencyKey of [
    "short",
    "",
    "has spaces in key",
    `way-too-long-${"x".repeat(200)}`,
  ]) {
    const denied = await fixture.asOwner.mutation(startJobRef, {
      organizationId: fixture.organizationId,
      projectId: fixture.projectId,
      text: COLLECT_TEXT,
      kind: "research",
      idempotencyKey,
    });
    expect(denied.ok, idempotencyKey).toBe(false);
    if (denied.ok) throw new Error(`invalid key unexpectedly accepted: ${idempotencyKey}`);
    expect(denied.code, idempotencyKey).toBe("invalid-payload");
    expect(await rowCounts(fixture), idempotencyKey).toEqual(before);
  }

  // Supplied-grant behavior is preserved exactly: a key combined with an
  // explicit grant fails closed before any job write.
  const issued = await fixture.asOwner.mutation(issueGrantRef, {
    organizationId: fixture.organizationId,
    projectId: fixture.projectId,
    operations: ["research.collect"],
    communicationProfile: "ownerRoleplay",
    recipientConfigVersion: 0,
    inputVersions: { brief: "v1" },
    payloadJson: JSON.stringify({ query: COLLECT_TEXT }),
    costCeilingMicroUsd: 100,
    roundLimit: 10,
    expiresAt: Date.now() + 600_000,
    workflowAuthorities: [{ operationId: "research.collect", projectId: fixture.projectId }],
  });
  expect(issued.ok).toBe(true);
  if (!issued.ok) throw new Error("grant setup failed");
  const mixed = await fixture.asOwner.mutation(startJobRef, {
    organizationId: fixture.organizationId,
    projectId: fixture.projectId,
    text: COLLECT_TEXT,
    operationId: "research.collect",
    kind: "research",
    grantId: issued.grantId,
    idempotencyKey: "e3-supplied-grant-01",
  });
  expect(mixed.ok).toBe(false);
  if (mixed.ok) throw new Error("key-plus-grant unexpectedly started");
  expect(mixed.code).toBe("invalid-payload");
  const afterGrant = await rowCounts(fixture);
  expect(afterGrant.jobs).toBe(0);
  expect(afterGrant.operations).toBe(0);
});
