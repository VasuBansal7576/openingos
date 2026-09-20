/// <reference types="vite/client" />

/**
 * J-03 controlled acceptance tests.
 *
 * These tests execute the actual Jev Convex action and F1 authority handlers
 * against the real schema.  The provider key and fetch responses are synthetic
 * and no request can reach the pinned external origin.
 */

import { afterEach, describe, expect, test, vi } from "vitest";
import { convexTest, type TestConvex } from "convex-test";
import {
  makeFunctionReference,
  type RegisteredAction,
  type RegisteredMutation,
} from "convex/server";
import type { Id } from "../_generated/dataModel.js";
import schema from "../schema.js";
import * as memberships from "../access/memberships.js";
import * as grants from "../access/grants.js";
import * as jobs from "../execution/jobs.js";
import * as reservations from "../execution/reservations.js";
import * as operations from "../execution/operations.js";
import * as jev from "./jev.js";
import { canonicalJson } from "../shared/hashing.js";

const rawModules = import.meta.glob([
  "../access/**/*.ts",
  "../execution/**/*.ts",
  "../shared/**/*.ts",
  "../server.ts",
  "../auth.ts",
  "./*.ts",
  "../_generated/*.js",
  "!../access/**/*.test.ts",
  "!../execution/**/*.test.ts",
  "!../shared/**/*.test.ts",
  "!./*.test.ts",
]);
const modules: Record<string, () => Promise<unknown>> = {};
for (const [path, loader] of Object.entries(rawModules)) {
  const relative = path.startsWith("./") ? `models/${path.slice(2)}` : path.replace(/^(\.\.\/)+/, "");
  modules[relative] = loader as () => Promise<unknown>;
}

type MutationArgs<T> = T extends RegisteredMutation<infer _Visibility, infer Args, infer _Return>
  ? Args
  : never;
type MutationReturn<T> = T extends RegisteredMutation<infer _Visibility, infer _Args, infer Return>
  ? Return
  : never;
type ActionArgs<T> = T extends RegisteredAction<infer _Visibility, infer Args, infer _Return>
  ? Args
  : never;
type ActionReturn<T> = T extends RegisteredAction<infer _Visibility, infer _Args, infer Return>
  ? Return
  : never;

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
const cancelJobRef = makeFunctionReference<
  "mutation",
  MutationArgs<typeof jobs.cancel>,
  MutationReturn<typeof jobs.cancel>
>("execution/jobs:cancel");
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
const classifyRef = makeFunctionReference<
  "action",
  ActionArgs<typeof jev.classify>,
  ActionReturn<typeof jev.classify>
>("models/jev:classify");

const OWNER = { tokenIdentifier: "j03-jev-owner" };
const QUESTIONS = {
  urgency: {
    type: "noul" as const,
    instructions: "Is this supplier request urgent?",
    criteria: { true: "urgent", false: "not urgent" },
  },
};
const STATE = { requirement: "espresso machine", supplier: "Acme" };

interface Fixture {
  readonly t: TestConvex<typeof schema>;
  readonly identity: string;
  readonly organizationId: Id<"organizations">;
  readonly projectId: Id<"projects">;
  readonly grantId: Id<"grants">;
  readonly jobId: Id<"jobs">;
  readonly operationId: Id<"operations">;
  readonly reservationId: Id<"reservations">;
}

function init(): TestConvex<typeof schema> {
  process.env.TYPESAFE_API_KEY = "controlled-jev-key";
  return convexTest(schema, modules);
}

async function createFixture(
  t: TestConvex<typeof schema>,
  requestId: string,
  reservationAmount = jev.JEV_MAX_RESERVATION_MICRO_USD,
): Promise<Fixture> {
  const asOwner = t.withIdentity(OWNER);
  const organization = await asOwner.mutation(createOrganizationRef, {
    name: "J-03 controlled organization",
    kind: "private",
  });
  if (!organization.ok) throw new Error(`organization setup failed: ${organization.message}`);
  const project = await asOwner.mutation(createProjectRef, {
    organizationId: organization.organizationId,
    name: "J-03 controlled project",
    visibility: "open",
  });
  if (!project.ok) throw new Error(`project setup failed: ${project.message}`);
  const query = "Research suppliers for the espresso machine";
  const grant = await asOwner.mutation(issueGrantRef, {
    organizationId: organization.organizationId,
    projectId: project.projectId,
    operations: ["research.collect"],
    communicationProfile: "ownerRoleplay",
    recipientConfigVersion: 0,
    inputVersions: { brief: "jev-v1" },
    payloadJson: canonicalJson({ query }),
    costCeilingMicroUsd: 10_000,
    roundLimit: 8,
    expiresAt: Date.now() + 60 * 60 * 1000,
  });
  if (!grant.ok) throw new Error(`grant setup failed: ${grant.message}`);
  await t.run(async (ctx) => {
    await ctx.db.insert("providerBudgets", {
      organizationId: organization.organizationId,
      ceilingMicroUsd: jev.JEV_MAX_RESERVATION_MICRO_USD,
      reservedMicroUsd: 0,
      spentMicroUsd: 0,
      unresolvedMicroUsd: 0,
      pricingBasis: jev.JEV_PRICING_BASIS,
      updatedAt: Date.now(),
    });
  });
  const started = await asOwner.mutation(startJobRef, {
    organizationId: organization.organizationId,
    projectId: project.projectId,
    text: query,
    operationId: "research.collect",
    kind: "research",
    grantId: grant.grantId,
  });
  if (!started.ok) throw new Error(`job setup failed: ${started.message}`);
  const reservation = await asOwner.mutation(reserveRef, {
    jobId: started.jobId,
    organizationId: organization.organizationId,
    projectId: project.projectId,
    amountMicroUsd: reservationAmount,
    pricingBasis: jev.JEV_PRICING_BASIS,
  });
  if (!reservation.ok) throw new Error(`reservation setup failed: ${reservation.message}`);
  const operation = await asOwner.mutation(createOperationRef, {
    jobId: started.jobId,
    organizationId: organization.organizationId,
    projectId: project.projectId,
    kind: "research.collect",
    requestId,
    payloadJson: canonicalJson({ query }),
    grantId: grant.grantId,
    reservationId: reservation.reservationId,
  });
  if (!operation.ok) throw new Error(`operation setup failed: ${operation.message}`);
  return {
    t,
    identity: OWNER.tokenIdentifier,
    organizationId: organization.organizationId,
    projectId: project.projectId,
    grantId: grant.grantId,
    jobId: started.jobId,
    operationId: operation.operationId,
    reservationId: reservation.reservationId,
  };
}

function response(status = 200): Response {
  return new Response(JSON.stringify({
    model: "jev-1.13.0",
    answers: { urgency: { type: "noul", noul: 0.9 } },
    usage: { input_tokens: 10, output_tokens: 4 },
  }), {
    status,
    headers: { "content-type": "application/json" },
  });
}

async function waitForCalls(calls: readonly unknown[], count: number): Promise<void> {
  const deadline = Date.now() + 1_000;
  while (calls.length < count && Date.now() < deadline) {
    await new Promise<void>((resolve) => setTimeout(resolve, 1));
  }
  if (calls.length < count) throw new Error(`expected ${count} provider calls, got ${calls.length}`);
}

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("J-03 Jev shared allowance and durable authority", () => {
  test("concurrent actual actions admit one full reservation and make zero second fetch calls", async () => {
    const t = init();
    const first = await createFixture(t, "jev-concurrent-first");
    const asOwner = t.withIdentity(OWNER);
    const secondJob = await asOwner.mutation(startJobRef, {
      organizationId: first.organizationId,
      projectId: first.projectId,
      text: "Research suppliers for the espresso machine",
      operationId: "research.collect",
      kind: "research",
      grantId: first.grantId,
    });
    if (!secondJob.ok) throw new Error(`second job setup failed: ${secondJob.message}`);
    const secondOperation = await asOwner.mutation(createOperationRef, {
      jobId: secondJob.jobId,
      organizationId: first.organizationId,
      projectId: first.projectId,
      kind: "research.collect",
      requestId: "jev-concurrent-second",
      payloadJson: canonicalJson({ query: "Research suppliers for the espresso machine" }),
      grantId: first.grantId,
    });
    if (!secondOperation.ok) throw new Error(`second operation setup failed: ${secondOperation.message}`);

    const secondReservation = await asOwner.mutation(reserveRef, {
      jobId: secondJob.jobId,
      organizationId: first.organizationId,
      projectId: first.projectId,
      amountMicroUsd: jev.JEV_MAX_RESERVATION_MICRO_USD,
      pricingBasis: jev.JEV_PRICING_BASIS,
    });
    expect(secondReservation).toMatchObject({ ok: false, code: "allowance-exhausted" });

    const calls: string[] = [];
    let releaseFirst: (() => void) | undefined;
    const firstFetchReleased = new Promise<void>((resolve) => {
      releaseFirst = resolve;
    });
    vi.stubGlobal("fetch", vi.fn(async (input: string | URL | Request) => {
      calls.push(String(input));
      if (calls.length === 1) await firstFetchReleased;
      return response();
    }));

    const firstAction = asOwner.action(classifyRef, {
      operationId: first.operationId,
      identity: first.identity,
      state: STATE,
      questions: QUESTIONS,
      inputVersion: "jev-v1",
    });
    await waitForCalls(calls, 1);
    const secondAction = await asOwner.action(classifyRef, {
      operationId: secondOperation.operationId,
      identity: first.identity,
      state: STATE,
      questions: QUESTIONS,
      inputVersion: "jev-v1",
    });
    expect(secondAction).toMatchObject({ ok: false, code: "allowance-exhausted" });
    expect(calls).toHaveLength(1);
    releaseFirst?.();
    const firstResult = await firstAction;
    expect(firstResult).toMatchObject({ outcome: "decided", attempts: 1 });
    expect(calls).toHaveLength(1);
  });

  test("accounts for exactly three retryable attempts and spends the bounded reservation", async () => {
    const t = init();
    const fixture = await createFixture(t, "jev-three-attempts");
    const calls: string[] = [];
    vi.stubGlobal("fetch", vi.fn(async (input: string | URL | Request) => {
      calls.push(String(input));
      return calls.length < 3 ? new Response("temporary", { status: 529 }) : response();
    }));

    const result = await t.withIdentity(OWNER).action(classifyRef, {
      operationId: fixture.operationId,
      identity: fixture.identity,
      state: STATE,
      questions: QUESTIONS,
      inputVersion: "jev-v1",
    });
    expect(result).toMatchObject({ outcome: "decided", attempts: 3 });
    expect(calls).toHaveLength(3);
    const accounting = await t.run(async (ctx) => {
      const reservation = await ctx.db.get(fixture.reservationId);
      const budget = await ctx.db
        .query("providerBudgets")
        .withIndex("by_organization", (q) => q.eq("organizationId", fixture.organizationId))
        .unique();
      return { reservation, budget };
    });
    expect(accounting.reservation).toMatchObject({
      state: "closed",
      reservedMicroUsd: 0,
      spentMicroUsd: jev.JEV_MAX_RESERVATION_MICRO_USD,
      unresolvedMicroUsd: 0,
    });
    expect(accounting.budget).toMatchObject({
      reservedMicroUsd: 0,
      spentMicroUsd: jev.JEV_MAX_RESERVATION_MICRO_USD,
      unresolvedMicroUsd: 0,
    });
  });

  test("releases a nonretryable one-attempt outcome", async () => {
    const t = init();
    const fixture = await createFixture(t, "jev-nonretryable");
    const calls: string[] = [];
    vi.stubGlobal("fetch", vi.fn(async (input: string | URL | Request) => {
      calls.push(String(input));
      return new Response("unauthorized", { status: 401 });
    }));

    const result = await t.withIdentity(OWNER).action(classifyRef, {
      operationId: fixture.operationId,
      identity: fixture.identity,
      state: STATE,
      questions: QUESTIONS,
      inputVersion: "jev-v1",
    });
    expect(result).toMatchObject({ outcome: "needsReview", attempts: 1 });
    expect(calls).toHaveLength(1);
    const accounting = await t.run(async (ctx) => {
      const reservation = await ctx.db.get(fixture.reservationId);
      const budget = await ctx.db
        .query("providerBudgets")
        .withIndex("by_organization", (q) => q.eq("organizationId", fixture.organizationId))
        .unique();
      return { reservation, budget };
    });
    expect(accounting.reservation).toMatchObject({
      state: "closed",
      reservedMicroUsd: 0,
      spentMicroUsd: 0,
      unresolvedMicroUsd: 0,
    });
    expect(accounting.budget).toMatchObject({
      reservedMicroUsd: 0,
      spentMicroUsd: 0,
      unresolvedMicroUsd: 0,
    });
  });

  test("retains an ambiguous transport failure as an unknown charge", async () => {
    const t = init();
    const fixture = await createFixture(t, "jev-unknown-transport");
    const calls: string[] = [];
    vi.stubGlobal("fetch", vi.fn(async () => {
      calls.push("transport");
      throw new Error("controlled transport interruption");
    }));

    const result = await t.withIdentity(OWNER).action(classifyRef, {
      operationId: fixture.operationId,
      identity: fixture.identity,
      state: STATE,
      questions: QUESTIONS,
      inputVersion: "jev-v1",
    });
    expect(result).toMatchObject({ outcome: "unavailable", reason: "transport-error", attempts: 3 });
    expect(calls).toHaveLength(3);
    const accounting = await t.run(async (ctx) => {
      const reservation = await ctx.db.get(fixture.reservationId);
      const budget = await ctx.db
        .query("providerBudgets")
        .withIndex("by_organization", (q) => q.eq("organizationId", fixture.organizationId))
        .unique();
      return { reservation, budget };
    });
    expect(accounting.reservation).toMatchObject({
      state: "open",
      reservedMicroUsd: 0,
      spentMicroUsd: 0,
      unresolvedMicroUsd: jev.JEV_MAX_RESERVATION_MICRO_USD,
    });
    expect(accounting.budget).toMatchObject({
      reservedMicroUsd: 0,
      spentMicroUsd: 0,
      unresolvedMicroUsd: jev.JEV_MAX_RESERVATION_MICRO_USD,
    });
  });

  test("cancellation during retry backoff makes zero next provider calls", async () => {
    const t = init();
    const fixture = await createFixture(t, "jev-cancel-between-attempts");
    const calls: string[] = [];
    vi.stubGlobal("fetch", vi.fn(async (input: string | URL | Request) => {
      calls.push(String(input));
      return new Response("temporary", { status: 529 });
    }));

    const action = t.withIdentity(OWNER).action(classifyRef, {
      operationId: fixture.operationId,
      identity: fixture.identity,
      state: STATE,
      questions: QUESTIONS,
      inputVersion: "jev-v1",
    });
    await waitForCalls(calls, 1);
    const cancelled = await t.withIdentity(OWNER).mutation(cancelJobRef, {
      jobId: fixture.jobId,
      reason: "controlled cancellation",
    });
    expect(cancelled).toMatchObject({ ok: true });
    const result = await action;
    expect(result).toMatchObject({ outcome: "stale", attempts: 1 });
    expect(calls).toHaveLength(1);
  });

  test("input-version drift during retry backoff makes zero next provider calls", async () => {
    const t = init();
    const fixture = await createFixture(t, "jev-input-drift");
    const calls: string[] = [];
    vi.stubGlobal("fetch", vi.fn(async (input: string | URL | Request) => {
      calls.push(String(input));
      return new Response("temporary", { status: 529 });
    }));

    const action = t.withIdentity(OWNER).action(classifyRef, {
      operationId: fixture.operationId,
      identity: fixture.identity,
      state: STATE,
      questions: QUESTIONS,
      inputVersion: "jev-v1",
    });
    await waitForCalls(calls, 1);
    await t.run(async (ctx) => {
      await ctx.db.patch(fixture.grantId, { inputVersions: { brief: "jev-v2" } });
    });
    const result = await action;
    expect(result).toMatchObject({ outcome: "stale", reason: "stale-input-version", attempts: 1 });
    expect(calls).toHaveLength(1);
  });

  test("a caller-supplied stale input version makes zero provider calls", async () => {
    const t = init();
    const fixture = await createFixture(t, "jev-stale-caller-input");
    const calls: string[] = [];
    vi.stubGlobal("fetch", vi.fn(async (input: string | URL | Request) => {
      calls.push(String(input));
      return response();
    }));

    const result = await t.withIdentity(OWNER).action(classifyRef, {
      operationId: fixture.operationId,
      identity: fixture.identity,
      state: STATE,
      questions: QUESTIONS,
      inputVersion: "jev-stale-version",
    });
    expect(result).toMatchObject({ outcome: "stale", reason: "stale-input-version", attempts: 0 });
    expect(calls).toHaveLength(0);
  });

  test("grant revocation-version drift during retry backoff makes zero next provider calls", async () => {
    const t = init();
    const fixture = await createFixture(t, "jev-grant-drift");
    const calls: string[] = [];
    vi.stubGlobal("fetch", vi.fn(async (input: string | URL | Request) => {
      calls.push(String(input));
      return new Response("temporary", { status: 529 });
    }));

    const action = t.withIdentity(OWNER).action(classifyRef, {
      operationId: fixture.operationId,
      identity: fixture.identity,
      state: STATE,
      questions: QUESTIONS,
      inputVersion: "jev-v1",
    });
    await waitForCalls(calls, 1);
    await t.run(async (ctx) => {
      await ctx.db.patch(fixture.grantId, { revocationVersion: 2 });
    });
    const result = await action;
    expect(result).toMatchObject({ outcome: "stale", reason: "stale-grant-version", attempts: 1 });
    expect(calls).toHaveLength(1);
  });

  test("approved-payload drift during retry backoff makes zero next provider calls", async () => {
    const t = init();
    const fixture = await createFixture(t, "jev-payload-drift");
    const calls: string[] = [];
    vi.stubGlobal("fetch", vi.fn(async (input: string | URL | Request) => {
      calls.push(String(input));
      return new Response("temporary", { status: 529 });
    }));

    const action = t.withIdentity(OWNER).action(classifyRef, {
      operationId: fixture.operationId,
      identity: fixture.identity,
      state: STATE,
      questions: QUESTIONS,
      inputVersion: "jev-v1",
    });
    await waitForCalls(calls, 1);
    await t.run(async (ctx) => {
      await ctx.db.patch(fixture.grantId, {
        canonicalPayload: canonicalJson({ query: "tampered after approval" }),
      });
    });
    const result = await action;
    expect(result).toMatchObject({ outcome: "stale", reason: "changed-draft", attempts: 1 });
    expect(calls).toHaveLength(1);
  });
});
