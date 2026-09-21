/// <reference types="vite/client" />

/**
 * F1 multi-model shared-budget regression tests (ADR-0004 spend contract).
 *
 * One organization-wide `providerBudgets` row is a shared allowance ledger
 * across branches, retries, and providers. Each reservation stays bound to
 * its own model family's exact pricing basis: a Jev and an OpenAI operation
 * must both pass their attempt fences against the same budget row, while a
 * stale or cross-family reservation basis must still fail closed before any
 * provider transport.
 *
 * Every provider response and fetch implementation in this file is synthetic.
 * No test calls api.typesafe.ai or api.openai.com and no credential value is
 * committed.
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
import * as openai from "./openai.js";
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

type MutationArgs<T> = T extends RegisteredMutation<infer _Visibility, infer Args, infer _Return> ? Args : never;
type MutationReturn<T> = T extends RegisteredMutation<infer _Visibility, infer _Args, infer Return> ? Return : never;
type ActionArgs<T> = T extends RegisteredAction<infer _Visibility, infer Args, infer _Return> ? Args : never;
type ActionReturn<T> = T extends RegisteredAction<infer _Visibility, infer _Args, infer Return> ? Return : never;

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
const classifyRef = makeFunctionReference<
  "action",
  ActionArgs<typeof jev.classify>,
  ActionReturn<typeof jev.classify>
>("models/jev:classify");
const generateRef = makeFunctionReference<
  "action",
  ActionArgs<typeof openai.generate>,
  ActionReturn<typeof openai.generate>
>("models/openai:generate");

const OWNER = { tokenIdentifier: "shared-budget-owner" };
const SHARED_BUDGET_BASIS = "shared-org-allowance-ledger";
const CONTROLLED_ENV = {
  TYPESAFE_API_KEY: "controlled-jev-key",
  [jev.JEV_PRICING_ENV_VARS.attemptMaxCostMicroUsd]: "1000",
  [jev.JEV_PRICING_ENV_VARS.pricingVersion]: "controlled-jev-v1",
  [jev.JEV_PRICING_ENV_VARS.pricingBasis]: "controlled-jev-pricing",
  [openai.OPENAI_API_KEY_ENV]: "controlled-openai-key",
  [openai.OPENAI_PRICING_ENV_VARS.inputMicroUsdPerMillion]: "750000",
  [openai.OPENAI_PRICING_ENV_VARS.outputMicroUsdPerMillion]: "4500000",
  [openai.OPENAI_PRICING_ENV_VARS.pricingVersion]: "controlled-openai-v1",
  [openai.OPENAI_PRICING_ENV_VARS.pricingBasis]: "controlled-openai-text-pricing",
  [openai.OPENAI_PRICING_ENV_VARS.maxInputTokens]: "4096",
  [openai.OPENAI_PRICING_ENV_VARS.maxOutputTokens]: "1024",
} as const;
const CONTROLLED_ENV_KEYS = Object.keys(CONTROLLED_ENV) as readonly string[];
const ORIGINAL_ENV = new Map(CONTROLLED_ENV_KEYS.map((key) => [key, process.env[key]] as const));

function init(): TestConvex<typeof schema> {
  return convexTest(schema, modules);
}

function controlledPolicies(): {
  readonly jevPolicy: jev.JevPricingPolicy;
  readonly openaiPolicy: openai.OpenAIPricingPolicy;
} {
  const jevResult = jev.loadJevPricingPolicy();
  if (!jevResult.ok) throw new Error(`controlled Jev pricing setup failed: ${jevResult.message}`);
  const openaiResult = openai.loadOpenAIPricingPolicy();
  if (!openaiResult.ok) throw new Error(`controlled OpenAI pricing setup failed: ${openaiResult.message}`);
  return { jevPolicy: jevResult.policy, openaiPolicy: openaiResult.policy };
}

const JEV_QUESTIONS = {
  urgency: {
    type: "noul" as const,
    instructions: "Is this supplier request urgent?",
    criteria: { true: "urgent", false: "not urgent" },
  },
} as const;
const JEV_STATE = { requirement: "espresso machine", supplier: "Acme" };

function jevResponse(): Response {
  return new Response(JSON.stringify({
    model: "jev-1.13.0",
    answers: { urgency: { type: "noul", noul: 0.9 } },
    usage: { input_tokens: 10, output_tokens: 4 },
  }), {
    status: 200,
    headers: { "content-type": "application/json" },
  });
}

function openaiWorkload(): openai.CommercialExtractionWorkload {
  return {
    kind: "commercialExtraction",
    inputVersion: "openai-v1",
    source: {
      sourceId: "source-espresso-1",
      version: "source:7",
      locator: "https://supplier.example/espresso#price",
      content: "Commercial espresso machine. Price EUR 4,250. Delivery in 3 weeks.",
    },
    fields: ["price", "delivery"],
  };
}

function openaiOutput(): openai.CommercialExtractionOutput {
  return {
    kind: "commercialExtraction",
    source: {
      sourceId: "source-espresso-1",
      version: "source:7",
      locator: "https://supplier.example/espresso#price",
    },
    fields: [
      { name: "price", value: "EUR 4,250" },
      { name: "delivery", value: "3 weeks" },
    ],
    confidence: "medium",
  };
}

function openaiResponse(): Response {
  return new Response(JSON.stringify({
    status: "completed",
    model: openai.OPENAI_PINNED_MODEL,
    output: [{
      type: "message",
      role: "assistant",
      status: "completed",
      content: [{ type: "output_text", text: JSON.stringify(openaiOutput()) }],
    }],
    usage: { input_tokens: 120, output_tokens: 24 },
  }), {
    status: 200,
    headers: { "content-type": "application/json" },
  });
}

interface FamilyFixture {
  readonly grantId: Id<"grants">;
  readonly jobId: Id<"jobs">;
  readonly operationId: Id<"operations">;
  readonly reservationId: Id<"reservations">;
  readonly payloadJson: string;
}

interface Fixture {
  readonly t: TestConvex<typeof schema>;
  readonly jevPolicy: jev.JevPricingPolicy;
  readonly openaiPolicy: openai.OpenAIPricingPolicy;
  readonly identity: string;
  readonly organizationId: Id<"organizations">;
  readonly projectId: Id<"projects">;
  readonly jev: FamilyFixture;
  readonly openai: FamilyFixture;
}

async function createSharedFixture(
  t: TestConvex<typeof schema>,
  requestIdPrefix: string,
): Promise<Fixture> {
  const asOwner = t.withIdentity(OWNER);
  const { jevPolicy, openaiPolicy } = controlledPolicies();
  const organization = await asOwner.mutation(createOrganizationRef, {
    name: "Shared budget controlled organization",
    kind: "private",
  });
  if (!organization.ok) throw new Error(`organization setup failed: ${organization.message}`);
  const organizationId = organization.organizationId;
  const project = await asOwner.mutation(createProjectRef, {
    organizationId,
    name: "Shared budget controlled project",
    visibility: "open",
  });
  if (!project.ok) throw new Error(`project setup failed: ${project.message}`);
  const projectId = project.projectId;

  const jevWorkload: jev.JevWorkload = {
    state: JEV_STATE,
    questions: JEV_QUESTIONS,
    inputVersion: "jev-v1",
  };
  const jevWorkloadSha256 = await jev.jevWorkloadSha256(jevWorkload);
  const jevPayloadJson = await jev.bindJevWorkloadPayload(
    jevWorkload,
    "Research suppliers for the espresso machine",
  );
  const openaiWorkloadSha256 = await openai.openAIWorkloadSha256(openaiWorkload());
  const openaiPayloadJson = canonicalJson({
    query: "Research suppliers for the espresso machine",
  });

  const jevGrant = await asOwner.mutation(issueGrantRef, {
    organizationId,
    projectId,
    operations: ["research.collect"],
    communicationProfile: "ownerRoleplay",
    recipientConfigVersion: 0,
    inputVersions: { brief: "jev-v1", [jev.JEV_WORKLOAD_INPUT_VERSION_KEY]: jevWorkloadSha256 },
    payloadJson: jevPayloadJson,
    costCeilingMicroUsd: jevPolicy.maxReservationMicroUsd,
    roundLimit: 8,
    expiresAt: Date.now() + 60 * 60 * 1000,
  });
  if (!jevGrant.ok) throw new Error(`Jev grant setup failed: ${jevGrant.message}`);
  const openaiGrant = await asOwner.mutation(issueGrantRef, {
    organizationId,
    projectId,
    operations: ["research.collect"],
    communicationProfile: "ownerRoleplay",
    recipientConfigVersion: 0,
    inputVersions: { brief: "openai-v1", [openai.OPENAI_WORKLOAD_INPUT_VERSION_KEY]: openaiWorkloadSha256 },
    payloadJson: openaiPayloadJson,
    costCeilingMicroUsd: openaiPolicy.maxReservationMicroUsd,
    roundLimit: 8,
    expiresAt: Date.now() + 60 * 60 * 1000,
  });
  if (!openaiGrant.ok) throw new Error(`OpenAI grant setup failed: ${openaiGrant.message}`);

  // One organization-wide provider allowance ledger shared by both model
  // families. Its basis label is deliberately not either family's exact
  // reservation basis.
  await t.run(async (ctx) => {
    await ctx.db.insert("providerBudgets", {
      organizationId,
      ceilingMicroUsd: jevPolicy.maxReservationMicroUsd + openaiPolicy.maxReservationMicroUsd,
      reservedMicroUsd: 0,
      spentMicroUsd: 0,
      unresolvedMicroUsd: 0,
      pricingBasis: SHARED_BUDGET_BASIS,
      updatedAt: Date.now(),
    });
  });

  async function familyFixture(
    family: "jev" | "openai",
    grantId: Id<"grants">,
    jobText: string,
    payloadJson: string,
    pricingBasis: string,
    amountMicroUsd: number,
  ): Promise<FamilyFixture> {
    const started = await asOwner.mutation(startJobRef, {
      organizationId,
      projectId,
      text: jobText,
      operationId: "research.collect",
      kind: "research",
      grantId,
    });
    if (!started.ok) throw new Error(`${family} job setup failed: ${started.message}`);
    const reservation = await asOwner.mutation(reserveRef, {
      jobId: started.jobId,
      organizationId,
      projectId,
      amountMicroUsd,
      pricingBasis,
    });
    if (!reservation.ok) throw new Error(`${family} reservation setup failed: ${reservation.message}`);
    const operation = await asOwner.mutation(createOperationRef, {
      jobId: started.jobId,
      organizationId,
      projectId,
      kind: "research.collect",
      requestId: `${requestIdPrefix}-${family}`,
      payloadJson,
      grantId,
      reservationId: reservation.reservationId,
    });
    if (!operation.ok) throw new Error(`${family} operation setup failed: ${operation.message}`);
    return {
      grantId,
      jobId: started.jobId,
      operationId: operation.operationId,
      reservationId: reservation.reservationId,
      payloadJson,
    };
  }

  const jevFixture = await familyFixture(
    "jev",
    jevGrant.grantId,
    "Research suppliers for the espresso machine",
    jevPayloadJson,
    jevPolicy.reservationPricingBasis,
    jevPolicy.maxReservationMicroUsd,
  );
  const openaiFixture = await familyFixture(
    "openai",
    openaiGrant.grantId,
    "Research suppliers for the espresso machine",
    openaiPayloadJson,
    openaiPolicy.reservationPricingBasis,
    openaiPolicy.maxReservationMicroUsd,
  );

  return {
    t,
    jevPolicy,
    openaiPolicy,
    identity: OWNER.tokenIdentifier,
    organizationId,
    projectId,
    jev: jevFixture,
    openai: openaiFixture,
  };
}

function stubFamilyFetch(): { calls: string[] } {
  const calls: string[] = [];
  vi.stubGlobal("fetch", vi.fn(async (input: string | URL | Request) => {
    const url = String(input);
    calls.push(url);
    if (url === "https://api.typesafe.ai/v1/systemone") return jevResponse();
    if (url === openai.OPENAI_ENDPOINT) return openaiResponse();
    throw new Error(`unexpected provider URL: ${url}`);
  }));
  return { calls };
}

beforeEach(() => {
  for (const [key, value] of Object.entries(CONTROLLED_ENV)) {
    process.env[key] = value;
  }
});

afterEach(() => {
  vi.unstubAllGlobals();
  for (const key of CONTROLLED_ENV_KEYS) {
    const original = ORIGINAL_ENV.get(key);
    if (original === undefined) delete process.env[key];
    else process.env[key] = original;
  }
});

describe("F1 multi-model shared provider allowance", () => {
  test("one organization and one budget row support separately reserved Jev and OpenAI operations with their different exact reservation bases", async () => {
    const t = init();
    const fixture = await createSharedFixture(t, "shared-budget-success");
    const { calls } = stubFamilyFetch();

    const jevResult = await t.withIdentity(OWNER).action(classifyRef, {
      operationId: fixture.jev.operationId,
      identity: fixture.identity,
      state: JEV_STATE,
      questions: JEV_QUESTIONS,
      inputVersion: "jev-v1",
    });
    expect(jevResult).toMatchObject({ outcome: "decided", attempts: 1 });

    const openaiResult = await t.withIdentity(OWNER).action(generateRef, {
      operationId: fixture.openai.operationId,
      identity: fixture.identity,
      inputVersion: "openai-v1",
      payloadJson: fixture.openai.payloadJson,
      workload: openaiWorkload(),
    });
    expect(openaiResult).toMatchObject({ outcome: "completed", attempts: 1 });

    expect(calls).toContain("https://api.typesafe.ai/v1/systemone");
    expect(calls).toContain(openai.OPENAI_ENDPOINT);
    expect(calls).toHaveLength(2);

    const state = await t.run(async (ctx) => ({
      budget: await ctx.db
        .query("providerBudgets")
        .withIndex("by_organization", (q) => q.eq("organizationId", fixture.organizationId))
        .unique(),
      reservations: [
        await ctx.db.get(fixture.jev.reservationId),
        await ctx.db.get(fixture.openai.reservationId),
      ],
    }));
    expect(state.budget).toMatchObject({
      pricingBasis: SHARED_BUDGET_BASIS,
      reservedMicroUsd: 0,
      spentMicroUsd: fixture.jevPolicy.maxReservationMicroUsd + fixture.openaiPolicy.maxReservationMicroUsd,
      unresolvedMicroUsd: 0,
    });
    expect(state.reservations[0]).toMatchObject({
      state: "closed",
      pricingBasis: fixture.jevPolicy.reservationPricingBasis,
      spentMicroUsd: fixture.jevPolicy.maxReservationMicroUsd,
      unresolvedMicroUsd: 0,
    });
    expect(state.reservations[1]).toMatchObject({
      state: "closed",
      pricingBasis: fixture.openaiPolicy.reservationPricingBasis,
      spentMicroUsd: fixture.openaiPolicy.maxReservationMicroUsd,
      unresolvedMicroUsd: 0,
    });
  });

  test("a cross-family Jev reservation basis fails closed before provider transport", async () => {
    const t = init();
    const fixture = await createSharedFixture(t, "shared-budget-jev-cross-family");
    await t.run(async (ctx) => {
      await ctx.db.patch(fixture.jev.reservationId, {
        pricingBasis: fixture.openaiPolicy.reservationPricingBasis,
      });
    });
    const { calls } = stubFamilyFetch();

    const result = await t.withIdentity(OWNER).action(classifyRef, {
      operationId: fixture.jev.operationId,
      identity: fixture.identity,
      state: JEV_STATE,
      questions: JEV_QUESTIONS,
      inputVersion: "jev-v1",
    });
    expect(result).toMatchObject({ outcome: "stale", reason: "stale-pricing-basis", attempts: 0 });
    expect(calls).toHaveLength(0);
  });

  test("a cross-family OpenAI reservation basis fails closed before provider transport", async () => {
    const t = init();
    const fixture = await createSharedFixture(t, "shared-budget-openai-cross-family");
    await t.run(async (ctx) => {
      await ctx.db.patch(fixture.openai.reservationId, {
        pricingBasis: fixture.jevPolicy.reservationPricingBasis,
      });
    });
    const { calls } = stubFamilyFetch();

    const result = await t.withIdentity(OWNER).action(generateRef, {
      operationId: fixture.openai.operationId,
      identity: fixture.identity,
      inputVersion: "openai-v1",
      payloadJson: fixture.openai.payloadJson,
      workload: openaiWorkload(),
    });
    expect(result).toMatchObject({ outcome: "stale", reason: "stale-pricing-basis", attempts: 0 });
    expect(calls).toHaveLength(0);
  });

  test("a caller-invented reservation basis fails closed before provider transport", async () => {
    const t = init();
    const fixture = await createSharedFixture(t, "shared-budget-invented-basis");
    await t.run(async (ctx) => {
      await ctx.db.patch(fixture.openai.reservationId, { pricingBasis: "caller-invented-pricing" });
    });
    const { calls } = stubFamilyFetch();

    const result = await t.withIdentity(OWNER).action(generateRef, {
      operationId: fixture.openai.operationId,
      identity: fixture.identity,
      inputVersion: "openai-v1",
      payloadJson: fixture.openai.payloadJson,
      workload: openaiWorkload(),
    });
    expect(result).toMatchObject({ outcome: "stale", reason: "stale-pricing-basis", attempts: 0 });
    expect(calls).toHaveLength(0);
  });

  test("a missing shared budget row fails closed at the claim fence before provider transport", async () => {
    const t = init();
    const fixture = await createSharedFixture(t, "shared-budget-missing-row");
    await t.run(async (ctx) => {
      const budget = await ctx.db
        .query("providerBudgets")
        .withIndex("by_organization", (q) => q.eq("organizationId", fixture.organizationId))
        .unique();
      if (budget !== null) await ctx.db.delete(budget._id);
    });
    const { calls } = stubFamilyFetch();

    const jevResult = await t.withIdentity(OWNER).action(classifyRef, {
      operationId: fixture.jev.operationId,
      identity: fixture.identity,
      state: JEV_STATE,
      questions: JEV_QUESTIONS,
      inputVersion: "jev-v1",
    });
    // The shared claim fence fails closed first when the allowance row is
    // gone; the model attempt fence retains the same budget existence and
    // organization check as a second fail-closed boundary.
    expect(jevResult).toMatchObject({ ok: false, code: "denied-membership" });
    expect(calls).toHaveLength(0);
  });
});
