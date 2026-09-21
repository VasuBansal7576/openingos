/// <reference types="vite/client" />

/**
 * J-03 controlled acceptance tests.
 *
 * These tests execute the actual Jev Convex action and F1 authority handlers
 * against the real schema.  The provider key and fetch responses are synthetic
 * and no request can reach the pinned external origin.
 */

import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";
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
const CONTROLLED_PRICING = {
  [jev.JEV_PRICING_ENV_VARS.attemptMaxCostMicroUsd]: "1000",
  [jev.JEV_PRICING_ENV_VARS.pricingVersion]: "controlled-v1",
  [jev.JEV_PRICING_ENV_VARS.pricingBasis]: "controlled-jev-pricing",
} as const;
const CONTROLLED_ENV_KEYS = [
  "TYPESAFE_API_KEY",
  ...Object.values(jev.JEV_PRICING_ENV_VARS),
] as const;
const ORIGINAL_ENV = new Map(
  CONTROLLED_ENV_KEYS.map((key) => [key, process.env[key]] as const),
);
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
  readonly pricing: jev.JevPricingPolicy;
  readonly identity: string;
  readonly organizationId: Id<"organizations">;
  readonly projectId: Id<"projects">;
  readonly grantId: Id<"grants">;
  readonly jobId: Id<"jobs">;
  readonly operationId: Id<"operations">;
  readonly reservationId: Id<"reservations">;
  readonly payloadJson: string;
}

function init(): TestConvex<typeof schema> {
  return convexTest(schema, modules);
}

function controlledPricing(): jev.JevPricingPolicy {
  const result = jev.loadJevPricingPolicy();
  if (!result.ok) throw new Error(`controlled Jev pricing setup failed: ${result.message}`);
  return result.policy;
}

async function createFixture(
  t: TestConvex<typeof schema>,
  requestId: string,
  reservationAmount?: number,
): Promise<Fixture> {
  const asOwner = t.withIdentity(OWNER);
  const pricing = controlledPricing();
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
  const inputVersion = "jev-v1";
  const workload: jev.JevWorkload = {
    state: STATE,
    questions: QUESTIONS,
    inputVersion,
  };
  const workloadSha256 = await jev.jevWorkloadSha256(workload);
  const payloadJson = await jev.bindJevWorkloadPayload(workload, query);
  const grant = await asOwner.mutation(issueGrantRef, {
    organizationId: organization.organizationId,
    projectId: project.projectId,
    operations: ["research.collect"],
    communicationProfile: "ownerRoleplay",
    recipientConfigVersion: 0,
    inputVersions: { brief: inputVersion, [jev.JEV_WORKLOAD_INPUT_VERSION_KEY]: workloadSha256 },
    payloadJson,
    costCeilingMicroUsd: 10_000,
    roundLimit: 8,
    expiresAt: Date.now() + 60 * 60 * 1000,
  });
  if (!grant.ok) throw new Error(`grant setup failed: ${grant.message}`);
  await t.run(async (ctx) => {
    await ctx.db.insert("providerBudgets", {
      organizationId: organization.organizationId,
      ceilingMicroUsd: pricing.maxReservationMicroUsd,
      reservedMicroUsd: 0,
      spentMicroUsd: 0,
      unresolvedMicroUsd: 0,
      pricingBasis: pricing.reservationPricingBasis,
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
    amountMicroUsd: reservationAmount ?? pricing.maxReservationMicroUsd,
    pricingBasis: pricing.reservationPricingBasis,
  });
  if (!reservation.ok) throw new Error(`reservation setup failed: ${reservation.message}`);
  const operation = await asOwner.mutation(createOperationRef, {
    jobId: started.jobId,
    organizationId: organization.organizationId,
    projectId: project.projectId,
    kind: "research.collect",
    requestId,
    payloadJson,
    grantId: grant.grantId,
    reservationId: reservation.reservationId,
  });
  if (!operation.ok) throw new Error(`operation setup failed: ${operation.message}`);
  return {
    t,
    pricing,
    identity: OWNER.tokenIdentifier,
    organizationId: organization.organizationId,
    projectId: project.projectId,
    grantId: grant.grantId,
    jobId: started.jobId,
    operationId: operation.operationId,
    reservationId: reservation.reservationId,
    payloadJson,
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
  for (const key of CONTROLLED_ENV_KEYS) {
    const original = ORIGINAL_ENV.get(key);
    if (original === undefined) delete process.env[key];
    else process.env[key] = original;
  }
});

beforeEach(() => {
  process.env.TYPESAFE_API_KEY = "controlled-jev-key";
  for (const [key, value] of Object.entries(CONTROLLED_PRICING)) {
    process.env[key] = value;
  }
});

async function expectNoClaim(t: TestConvex<typeof schema>, fixture: Fixture): Promise<void> {
  const state = await t.run(async (ctx) => ({
    operation: await ctx.db.get(fixture.operationId),
    attempts: await ctx.db
      .query("attempts")
      .withIndex("by_operation", (q) => q.eq("operationId", fixture.operationId))
      .collect(),
    reservation: await ctx.db.get(fixture.reservationId),
  }));
  expect(state.operation?.state).toBe("prepared");
  expect(state.operation?.attemptToken).toBeUndefined();
  expect(state.attempts).toHaveLength(0);
  expect(state.reservation).toMatchObject({
    state: "open",
    reservedMicroUsd: fixture.pricing.maxReservationMicroUsd,
    spentMicroUsd: 0,
    unresolvedMicroUsd: 0,
  });
}

async function expectUnknownAccounting(t: TestConvex<typeof schema>, fixture: Fixture): Promise<void> {
  const state = await t.run(async (ctx) => ({
    operation: await ctx.db.get(fixture.operationId),
    attempts: await ctx.db
      .query("attempts")
      .withIndex("by_operation", (q) => q.eq("operationId", fixture.operationId))
      .collect(),
    reservation: await ctx.db.get(fixture.reservationId),
    budget: await ctx.db
      .query("providerBudgets")
      .withIndex("by_organization", (q) => q.eq("organizationId", fixture.organizationId))
      .unique(),
  }));
  expect(state.operation?.state).toBe("outcomeUnknown");
  expect(state.attempts).toHaveLength(1);
  expect(state.attempts[0]?.state).toBe("outcomeUnknown");
  expect(state.reservation).toMatchObject({
    state: "open",
    reservedMicroUsd: 0,
    spentMicroUsd: 0,
    unresolvedMicroUsd: fixture.pricing.maxReservationMicroUsd,
  });
  expect(state.budget).toMatchObject({
    reservedMicroUsd: 0,
    spentMicroUsd: 0,
    unresolvedMicroUsd: fixture.pricing.maxReservationMicroUsd,
  });
}

describe("J-03 Jev shared allowance and durable authority", () => {
  test("missing pricing configuration refuses before claim or provider call", async () => {
    const t = init();
    const fixture = await createFixture(t, "jev-pricing-missing");
    delete process.env[jev.JEV_PRICING_ENV_VARS.attemptMaxCostMicroUsd];
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
      inputVersion: "jev-v1",
    });
    expect(result).toMatchObject({ ok: false, code: "invalid-pricing-config" });
    expect(calls).toHaveLength(0);
    await expectNoClaim(t, fixture);
  });

  test("invalid pricing configuration refuses before claim or provider call", async () => {
    const t = init();
    const fixture = await createFixture(t, "jev-pricing-invalid");
    process.env[jev.JEV_PRICING_ENV_VARS.attemptMaxCostMicroUsd] = "0";
    process.env[jev.JEV_PRICING_ENV_VARS.pricingVersion] = "   ";
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
      inputVersion: "jev-v1",
    });
    expect(result).toMatchObject({ ok: false, code: "invalid-pricing-config" });
    expect(calls).toHaveLength(0);
    await expectNoClaim(t, fixture);
  });

  test("overflowing three-attempt pricing configuration refuses before claim or provider call", async () => {
    const t = init();
    const fixture = await createFixture(t, "jev-pricing-overflow");
    process.env[jev.JEV_PRICING_ENV_VARS.attemptMaxCostMicroUsd] = "9007199254740991";
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
      inputVersion: "jev-v1",
    });
    expect(result).toMatchObject({ ok: false, code: "invalid-pricing-config" });
    expect(calls).toHaveLength(0);
    await expectNoClaim(t, fixture);
  });

  test("stale pricing basis refuses before provider dispatch", async () => {
    const t = init();
    const fixture = await createFixture(t, "jev-pricing-stale-basis");
    await t.run(async (ctx) => {
      await ctx.db.patch(fixture.reservationId, { pricingBasis: "caller-invented-pricing" });
    });
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
      inputVersion: "jev-v1",
    });
    expect(result).toMatchObject({ outcome: "stale", reason: "stale-pricing-basis", attempts: 0 });
    expect(calls).toHaveLength(0);
  });

  test("pricing version drift refuses an old reservation before provider dispatch", async () => {
    const t = init();
    const fixture = await createFixture(t, "jev-pricing-stale-version");
    process.env[jev.JEV_PRICING_ENV_VARS.pricingVersion] = "controlled-v2";
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
      inputVersion: "jev-v1",
    });
    expect(result).toMatchObject({ outcome: "stale", reason: "stale-pricing-basis", attempts: 0 });
    expect(calls).toHaveLength(0);
  });

  test("an undersized reservation refuses before provider dispatch", async () => {
    const t = init();
    const fixture = await createFixture(t, "jev-pricing-undersized", 1_000);
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
      inputVersion: "jev-v1",
    });
    expect(result).toMatchObject({ outcome: "stale", reason: "allowance-exhausted", attempts: 0 });
    expect(calls).toHaveLength(0);
  });

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
      payloadJson: first.payloadJson,
      grantId: first.grantId,
    });
    if (!secondOperation.ok) throw new Error(`second operation setup failed: ${secondOperation.message}`);

    const secondReservation = await asOwner.mutation(reserveRef, {
      jobId: secondJob.jobId,
      organizationId: first.organizationId,
      projectId: first.projectId,
      amountMicroUsd: first.pricing.maxReservationMicroUsd,
      pricingBasis: first.pricing.reservationPricingBasis,
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
      spentMicroUsd: fixture.pricing.maxReservationMicroUsd,
      unresolvedMicroUsd: 0,
    });
    expect(accounting.budget).toMatchObject({
      reservedMicroUsd: 0,
      spentMicroUsd: fixture.pricing.maxReservationMicroUsd,
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
      unresolvedMicroUsd: fixture.pricing.maxReservationMicroUsd,
    });
    expect(accounting.budget).toMatchObject({
      reservedMicroUsd: 0,
      spentMicroUsd: 0,
      unresolvedMicroUsd: fixture.pricing.maxReservationMicroUsd,
    });
  });

  test("retains unknown exposure for a malformed successful response", async () => {
    const t = init();
    const fixture = await createFixture(t, "jev-unknown-response-shape");
    const calls: string[] = [];
    vi.stubGlobal("fetch", vi.fn(async () => {
      calls.push("response-shape");
      return new Response("{}", {
        status: 200,
        headers: { "content-type": "application/json" },
      });
    }));

    const result = await t.withIdentity(OWNER).action(classifyRef, {
      operationId: fixture.operationId,
      identity: fixture.identity,
      state: STATE,
      questions: QUESTIONS,
      inputVersion: "jev-v1",
    });
    expect(result).toMatchObject({ outcome: "needsReview", reason: "response-keys", attempts: 1 });
    expect(calls).toHaveLength(1);
    await expectUnknownAccounting(t, fixture);
  });

  test("retains an earlier lost response when a later attempt is definitively rejected", async () => {
    const t = init();
    const fixture = await createFixture(t, "jev-unknown-then-401");
    const calls: string[] = [];
    vi.stubGlobal("fetch", vi.fn(async () => {
      calls.push("attempt");
      if (calls.length === 1) throw new Error("controlled response loss");
      return new Response("unauthorized", { status: 401 });
    }));

    const result = await t.withIdentity(OWNER).action(classifyRef, {
      operationId: fixture.operationId,
      identity: fixture.identity,
      state: STATE,
      questions: QUESTIONS,
      inputVersion: "jev-v1",
    });
    expect(result).toMatchObject({ outcome: "needsReview", reason: "http-401", attempts: 2 });
    expect(calls).toHaveLength(2);
    await expectUnknownAccounting(t, fixture);
  });

  test("rejects changed Jev state or questions before claiming an operation", async () => {
    const cases = [
      {
        state: { ...STATE, supplier: "Changed" },
        questions: QUESTIONS,
      },
      {
        state: STATE,
        questions: {
          ...QUESTIONS,
          urgency: {
            ...QUESTIONS.urgency,
            instructions: "A changed approved question",
          },
        },
      },
    ] as const;

    for (const [index, workload] of cases.entries()) {
      const t = init();
      const fixture = await createFixture(t, `jev-workload-drift-${index}`);
      const calls: string[] = [];
      vi.stubGlobal("fetch", vi.fn(async () => {
        calls.push("unexpected-provider-call");
        return response();
      }));

      const result = await t.withIdentity(OWNER).action(classifyRef, {
        operationId: fixture.operationId,
        identity: fixture.identity,
        state: workload.state,
        questions: workload.questions,
        inputVersion: "jev-v1",
      });
      expect(result).toMatchObject({ outcome: "stale", reason: "stale-input-version", attempts: 0 });
      expect(calls).toHaveLength(0);
      await expectNoClaim(t, fixture);
      vi.unstubAllGlobals();
    }
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
