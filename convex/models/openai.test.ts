/// <reference types="vite/client" />

/**
 * Controlled OpenAI Responses boundary tests.
 *
 * Every provider response and fetch implementation in this file is synthetic.
 * No test calls api.openai.com and no credential value is committed.
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
import * as openai from "./openai.js";
import { canonicalJson } from "../shared/hashing.js";

const rawModules = import.meta.glob([
  "../access/**/*.ts",
  "../execution/**/*.ts",
  "../shared/**/*.ts",
  "../server.ts",
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
const frontendSources = import.meta.glob("../../app/**/*.{ts,tsx}", {
  eager: true,
  query: "?raw",
  import: "default",
}) as Record<string, string>;

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
const generateRef = makeFunctionReference<
  "action",
  ActionArgs<typeof openai.generate>,
  ActionReturn<typeof openai.generate>
>("models/openai:generate");

const OWNER = { tokenIdentifier: "controlled-openai-owner" };
const CONTROLLED_ENV = {
  [openai.OPENAI_API_KEY_ENV]: "controlled-openai-key",
  [openai.OPENAI_PRICING_ENV_VARS.inputMicroUsdPerMillion]: "750000",
  [openai.OPENAI_PRICING_ENV_VARS.outputMicroUsdPerMillion]: "4500000",
  [openai.OPENAI_PRICING_ENV_VARS.pricingVersion]: "controlled-openai-v1",
  [openai.OPENAI_PRICING_ENV_VARS.pricingBasis]: "controlled-openai-text-pricing",
  [openai.OPENAI_PRICING_ENV_VARS.maxInputTokens]: "4096",
  [openai.OPENAI_PRICING_ENV_VARS.maxOutputTokens]: "1024",
} as const;
const CONTROLLED_ENV_KEYS = [
  openai.OPENAI_API_KEY_ENV,
  ...Object.values(openai.OPENAI_PRICING_ENV_VARS),
] as const;
const ORIGINAL_ENV = new Map(CONTROLLED_ENV_KEYS.map((key) => [key, process.env[key]] as const));

function init(): TestConvex<typeof schema> {
  return convexTest(schema, modules);
}

function controlledPricing(): openai.OpenAIPricingPolicy {
  const result = openai.loadOpenAIPricingPolicy();
  if (!result.ok) throw new Error(`controlled OpenAI pricing setup failed: ${result.message}`);
  return result.policy;
}

function extractionWorkload(inputVersion = "openai-v1"): openai.CommercialExtractionWorkload {
  return {
    kind: "commercialExtraction",
    inputVersion,
    source: {
      sourceId: "source-espresso-1",
      version: "source:7",
      locator: "https://supplier.example/espresso#price",
      content: "Commercial espresso machine. Price EUR 4,250. Delivery in 3 weeks.",
    },
    fields: ["price", "delivery"],
  };
}

function draftWorkload(inputVersion = "openai-v1"): openai.SupplierDraftWorkload {
  return {
    kind: "supplierDraft",
    inputVersion,
    draftKind: "clarification",
    brief: "Ask for installation scope and a firm delivery window.",
    sources: [
      {
        sourceId: "source-espresso-1",
        version: "source:7",
        locator: "message:reply-1#delivery",
        content: "Supplier response says delivery is estimated and installation is not listed.",
      },
    ],
  };
}

function extractionOutput(): openai.CommercialExtractionOutput {
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

function draftOutput(): openai.SupplierDraftOutput {
  return {
    kind: "supplierDraft",
    draftKind: "clarification",
    content: "Could you confirm the installation scope and firm delivery window?",
    sources: [{
      sourceId: "source-espresso-1",
      version: "source:7",
      locator: "message:reply-1#delivery",
    }],
  };
}

function providerResponse(
  output: openai.OpenAIOutput = extractionOutput(),
  overrides: Record<string, unknown> = {},
): Response {
  return new Response(JSON.stringify({
    status: "completed",
    model: openai.OPENAI_PINNED_MODEL,
    output: [{
      type: "message",
      role: "assistant",
      status: "completed",
      content: [{ type: "output_text", text: JSON.stringify(output) }],
    }],
    usage: { input_tokens: 120, output_tokens: 24 },
    ...overrides,
  }), {
    status: 200,
    headers: { "content-type": "application/json" },
  });
}

async function runPure(
  overrides: Partial<openai.OpenAIWorkloadOptions> = {},
): Promise<openai.OpenAIOutcome> {
  const pricing = controlledPricing();
  return openai.runOpenAIWorkload({
    apiKey: "controlled-openai-key",
    workload: extractionWorkload(),
    inputVersion: "openai-v1",
    pricing,
    fetchImpl: async () => providerResponse(),
    ...overrides,
  });
}

interface Fixture {
  readonly t: TestConvex<typeof schema>;
  readonly pricing: openai.OpenAIPricingPolicy;
  readonly organizationId: Id<"organizations">;
  readonly projectId: Id<"projects">;
  readonly grantId: Id<"grants">;
  readonly jobId: Id<"jobs">;
  readonly operationId: Id<"operations">;
  readonly reservationId: Id<"reservations">;
  readonly payloadJson: string;
}

async function createFixture(
  t: TestConvex<typeof schema>,
  requestId: string,
  reservationAmount?: number,
): Promise<Fixture> {
  const asOwner = t.withIdentity(OWNER);
  const pricing = controlledPricing();
  const organization = await asOwner.mutation(createOrganizationRef, {
    name: "OpenAI controlled organization",
    kind: "private",
  });
  if (!organization.ok) throw new Error(`organization setup failed: ${organization.message}`);
  const project = await asOwner.mutation(createProjectRef, {
    organizationId: organization.organizationId,
    name: "OpenAI controlled project",
    visibility: "open",
  });
  if (!project.ok) throw new Error(`project setup failed: ${project.message}`);
  const workloadSha256 = await openai.openAIWorkloadSha256(extractionWorkload());
  const payloadJson = canonicalJson({ query: "Research suppliers for the espresso machine" });
  const grant = await asOwner.mutation(issueGrantRef, {
    organizationId: organization.organizationId,
    projectId: project.projectId,
    operations: ["research.collect"],
    communicationProfile: "ownerRoleplay",
    recipientConfigVersion: 0,
    inputVersions: {
      brief: "openai-v1",
      [openai.OPENAI_WORKLOAD_INPUT_VERSION_KEY]: workloadSha256,
    },
    payloadJson,
    costCeilingMicroUsd: Math.max(10_000, pricing.maxReservationMicroUsd * 2),
    roundLimit: 8,
    expiresAt: Date.now() + 60 * 60 * 1000,
  });
  if (!grant.ok) throw new Error(`grant setup failed: ${grant.message}`);
  await t.run(async (ctx) => {
    await ctx.db.insert("providerBudgets", {
      organizationId: organization.organizationId,
      ceilingMicroUsd: pricing.maxReservationMicroUsd * 2,
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
    text: "Research suppliers for the espresso machine",
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
    organizationId: organization.organizationId,
    projectId: project.projectId,
    grantId: grant.grantId,
    jobId: started.jobId,
    operationId: operation.operationId,
    reservationId: reservation.reservationId,
    payloadJson,
  };
}

async function createSupplierDraftFixture(
  t: TestConvex<typeof schema>,
  requestId: string,
): Promise<Fixture> {
  const asOwner = t.withIdentity(OWNER);
  const pricing = controlledPricing();
  const organization = await asOwner.mutation(createOrganizationRef, {
    name: "OpenAI controlled communication organization",
    kind: "private",
  });
  if (!organization.ok) throw new Error(`organization setup failed: ${organization.message}`);
  const project = await asOwner.mutation(createProjectRef, {
    organizationId: organization.organizationId,
    name: "OpenAI controlled communication project",
    visibility: "open",
  });
  if (!project.ok) throw new Error(`project setup failed: ${project.message}`);
  const workload = draftWorkload();
  const workloadSha256 = await openai.openAIWorkloadSha256(workload);
  const payloadJson = canonicalJson({
    profile: "ownerRoleplay",
    to: "owner@example.test",
    cc: [],
    bcc: [],
    subject: "Clarification request",
    body: "Send an RFQ clarification to the supplier.",
  });
  await t.run(async (ctx) => {
    await ctx.db.insert("recipientConfigs", {
      version: 1,
      mailboxNormalized: "owner@example.test",
      mailboxHash: "controlled-mailbox",
      active: true,
      configuredAt: Date.now(),
      configuredBy: "controlled-test",
    });
  });
  const grant = await asOwner.mutation(issueGrantRef, {
    organizationId: organization.organizationId,
    projectId: project.projectId,
    operations: ["communication.send"],
    communicationProfile: "ownerRoleplay",
    recipientConfigVersion: 1,
    inputVersions: {
      brief: "openai-v1",
      [openai.OPENAI_WORKLOAD_INPUT_VERSION_KEY]: workloadSha256,
    },
    payloadJson,
    costCeilingMicroUsd: Math.max(10_000, pricing.maxReservationMicroUsd * 2),
    roundLimit: 8,
    expiresAt: Date.now() + 60 * 60 * 1000,
  });
  if (!grant.ok) throw new Error(`grant setup failed: ${grant.message}`);
  await t.run(async (ctx) => {
    await ctx.db.insert("providerBudgets", {
      organizationId: organization.organizationId,
      ceilingMicroUsd: pricing.maxReservationMicroUsd * 2,
      reservedMicroUsd: 0,
      spentMicroUsd: 0,
      unresolvedMicroUsd: 0,
      pricingBasis: pricing.reservationPricingBasis,
      updatedAt: Date.now(),
    });
    const conversationId = await ctx.db.insert("conversations", {
      organizationId: organization.organizationId,
      projectId: project.projectId,
      grantId: grant.grantId,
      version: 1,
      state: "awaitingReply",
      recipientConfigVersion: 1,
      updatedAt: Date.now(),
    });
    await ctx.db.patch(grant.grantId, { conversationId });
  });
  const started = await asOwner.mutation(startJobRef, {
    organizationId: organization.organizationId,
    projectId: project.projectId,
    text: "Send an RFQ clarification to the supplier.",
    operationId: "communication.send",
    kind: "communication",
    grantId: grant.grantId,
  });
  if (!started.ok) throw new Error(`job setup failed: ${started.message}`);
  const reservation = await asOwner.mutation(reserveRef, {
    jobId: started.jobId,
    organizationId: organization.organizationId,
    projectId: project.projectId,
    amountMicroUsd: pricing.maxReservationMicroUsd,
    pricingBasis: pricing.reservationPricingBasis,
  });
  if (!reservation.ok) throw new Error(`reservation setup failed: ${reservation.message}`);
  const operation = await asOwner.mutation(createOperationRef, {
    jobId: started.jobId,
    organizationId: organization.organizationId,
    projectId: project.projectId,
    kind: "communication.send",
    requestId,
    payloadJson,
    grantId: grant.grantId,
    reservationId: reservation.reservationId,
  });
  if (!operation.ok) throw new Error(`operation setup failed: ${operation.message}`);
  return {
    t,
    pricing,
    organizationId: organization.organizationId,
    projectId: project.projectId,
    grantId: grant.grantId,
    jobId: started.jobId,
    operationId: operation.operationId,
    reservationId: reservation.reservationId,
    payloadJson,
  };
}

interface OperationSnapshot {
  readonly operation: { readonly state?: string } | null;
  readonly attempts: readonly unknown[];
  readonly reservation: { readonly state: string; readonly reservedMicroUsd: number; readonly spentMicroUsd: number; readonly unresolvedMicroUsd: number } | null;
  readonly budget: { readonly reservedMicroUsd: number; readonly spentMicroUsd: number; readonly unresolvedMicroUsd: number } | null;
}

async function operationState(t: TestConvex<typeof schema>, fixture: Fixture): Promise<OperationSnapshot> {
  return await t.run(async (ctx) => ({
    operation: await ctx.db.get(fixture.operationId),
    attempts: await ctx.db.query("attempts").withIndex("by_operation", (q) => q.eq("operationId", fixture.operationId)).collect(),
    reservation: await ctx.db.get(fixture.reservationId),
    budget: await ctx.db.query("providerBudgets").withIndex("by_organization", (q) => q.eq("organizationId", fixture.organizationId)).unique(),
  })) as OperationSnapshot;
}

beforeEach(() => {
  for (const [key, value] of Object.entries(CONTROLLED_ENV)) process.env[key] = value;
});

afterEach(() => {
  vi.unstubAllGlobals();
  for (const key of CONTROLLED_ENV_KEYS) {
    const original = ORIGINAL_ENV.get(key);
    if (original === undefined) delete process.env[key];
    else process.env[key] = original;
  }
});

describe("OpenAI Responses transport boundary", () => {
  test("sends one exact server-side request with redacted authentication and strict output", async () => {
    let receivedUrl = "";
    let receivedInit: RequestInit | undefined;
    const result = await runPure({
      fetchImpl: async (url, init) => {
        receivedUrl = String(url);
        receivedInit = init;
        return providerResponse();
      },
    });
    expect(result).toMatchObject({ outcome: "completed", model: openai.OPENAI_PINNED_MODEL, attempts: 1 });
    expect(receivedUrl).toBe(openai.OPENAI_ENDPOINT);
    expect(receivedInit?.method).toBe("POST");
    expect(receivedInit?.redirect).toBe("manual");
    expect(receivedInit?.headers).toEqual({
      Authorization: "Bearer controlled-openai-key",
      "Content-Type": "application/json",
      Accept: "application/json",
    });
    const body = JSON.parse(String(receivedInit?.body)) as Record<string, unknown>;
    expect(body).toMatchObject({
      model: openai.OPENAI_PINNED_MODEL,
      store: false,
      tools: [],
      truncation: "disabled",
      max_output_tokens: 1024,
      reasoning: { effort: "none" },
    });
    const text = body["text"] as Record<string, unknown>;
    const format = text["format"] as Record<string, unknown>;
    expect(format).toMatchObject({ type: "json_schema", strict: true });
    expect(typeof format["schema"]).toBe("object");
    expect(String(body["input"])).toContain("Commercial espresso machine");
    expect(JSON.stringify(result)).not.toContain("controlled-openai-key");
  });

  test("supports a supplier draft with source locator and version citations", async () => {
    const result = await openai.runOpenAIWorkload({
      apiKey: "controlled-openai-key",
      workload: draftWorkload(),
      inputVersion: "openai-v1",
      pricing: controlledPricing(),
      fetchImpl: async () => providerResponse(draftOutput()),
    });
    expect(result).toMatchObject({ outcome: "completed", output: draftOutput() });
  });

  test("binds every prompt-affecting supplier draft field into the approved input version", async () => {
    const digest = await openai.openAIWorkloadSha256(draftWorkload());
    const changed = await openai.openAIWorkloadSha256({
      ...draftWorkload(),
      brief: "Ask for a confirmed installation date.",
    });
    expect(digest).toMatch(/^[0-9a-f]{64}$/);
    expect(changed).not.toBe(digest);
  });

  test("rejects malformed, incomplete, model-drifted, schema-invalid, and invalid-usage responses", async () => {
    const cases: Array<{ name: string; response: Response }> = [
      { name: "malformed", response: new Response("not-json", { status: 200 }) },
      { name: "model-drift", response: providerResponse(extractionOutput(), { model: "gpt-5.4-mini" }) },
      { name: "not-completed", response: providerResponse(extractionOutput(), { status: "incomplete" }) },
      {
        name: "schema-invalid",
        response: providerResponse({ ...extractionOutput(), source: { ...extractionOutput().source, version: "source:other" } }),
      },
      { name: "usage-negative", response: providerResponse(extractionOutput(), { usage: { input_tokens: -1, output_tokens: 1 } }) },
      { name: "usage-fraction", response: providerResponse(extractionOutput(), { usage: { input_tokens: 1.5, output_tokens: 1 } }) },
      { name: "usage-over-ceiling", response: providerResponse(extractionOutput(), { usage: { input_tokens: 4097, output_tokens: 1 } }) },
    ];
    for (const entry of cases) {
      const result = await runPure({ fetchImpl: async () => entry.response });
      expect(result.outcome, entry.name).toBe("rejected");
    }
  });

  test("rejects oversized sources before fetch and never truncates bytes", async () => {
    const fetchImpl = vi.fn(async () => providerResponse());
    const tooLarge = { ...extractionWorkload(), source: { ...extractionWorkload().source, content: "x".repeat(openai.OPENAI_MAX_SOURCE_BYTES + 1) } };
    const result = await openai.runOpenAIWorkload({
      apiKey: "controlled-openai-key",
      workload: tooLarge,
      inputVersion: "openai-v1",
      pricing: controlledPricing(),
      fetchImpl,
    });
    expect(result).toMatchObject({ outcome: "rejected", reason: "source-too-large" });
    expect(fetchImpl).not.toHaveBeenCalled();
  });

  test("makes no hidden retry and retains ambiguous transport exposure", async () => {
    const fetchImpl = vi.fn(async () => {
      throw new Error("controlled transport interruption");
    });
    const result = await runPure({ fetchImpl });
    expect(result).toMatchObject({ outcome: "unavailable", reason: "transport-error", attempts: 1 });
    expect(fetchImpl).toHaveBeenCalledTimes(1);
  });

  test("fences pre-cancelled, stale, and authority-invalidated requests before fetch", async () => {
    const fetchImpl = vi.fn(async () => providerResponse());
    const controller = new AbortController();
    controller.abort();
    const cancelled = await runPure({ fetchImpl, signal: controller.signal });
    expect(cancelled).toMatchObject({ outcome: "stale", attempts: 0 });
    expect(fetchImpl).not.toHaveBeenCalled();
    const stale = await runPure({ fetchImpl, beforeAttempt: async () => ({ ok: false as const, reason: "stale-input-version" }) });
    expect(stale).toMatchObject({ outcome: "stale", reason: "stale-input-version", attempts: 0 });
    const authority = await runPure({ fetchImpl, isCurrentAuthority: () => false });
    expect(authority).toMatchObject({ outcome: "stale", reason: "authority-invalidated", attempts: 0 });
    expect(fetchImpl).not.toHaveBeenCalled();
  });

  test("timeout is one ambiguous attempt", async () => {
    const result = await openai.runOpenAIWorkload({
      apiKey: "controlled-openai-key",
      workload: extractionWorkload(),
      inputVersion: "openai-v1",
      pricing: controlledPricing(),
      timeoutMs: 5,
      fetchImpl: async (_url, init) => new Promise<Response>((_resolve, reject) => {
        init?.signal?.addEventListener("abort", () => reject(new Error("aborted")), { once: true });
      }),
    });
    expect(result).toMatchObject({ outcome: "unavailable", reason: "timeout", attempts: 1 });
  });
});

describe("OpenAI pricing and shared execution boundary", () => {
  test("the internal handler validator rejects malformed and extra-key workloads before claim or fetch", async () => {
    const t = init();
    const fixture = await createFixture(t, "openai-invalid-workload");
    const fetchImpl = vi.fn(async () => providerResponse());
    vi.stubGlobal("fetch", fetchImpl);
    const malformedWorkload = JSON.parse(JSON.stringify({
      ...extractionWorkload(),
      injected: "cannot become an instruction",
    })) as unknown as ActionArgs<typeof openai.generate>["workload"];
    await expect(t.withIdentity(OWNER).action(generateRef, {
      operationId: fixture.operationId,
      identity: OWNER.tokenIdentifier,
      inputVersion: "openai-v1",
      payloadJson: fixture.payloadJson,
      workload: malformedWorkload,
    })).rejects.toThrow();
    expect(fetchImpl).not.toHaveBeenCalled();
    const state = await operationState(t, fixture);
    expect(state.operation?.state).toBe("prepared");
    expect(state.attempts).toHaveLength(0);
  });

  test("missing or invalid pricing configuration fails before claim or fetch", async () => {
    const t = init();
    const fixture = await createFixture(t, "openai-missing-pricing");
    const fetchImpl = vi.fn(async () => providerResponse());
    vi.stubGlobal("fetch", fetchImpl);
    delete process.env[openai.OPENAI_PRICING_ENV_VARS.inputMicroUsdPerMillion];
    const result = await t.withIdentity(OWNER).action(generateRef, {
      operationId: fixture.operationId,
      identity: OWNER.tokenIdentifier,
      inputVersion: "openai-v1",
      payloadJson: fixture.payloadJson,
      workload: extractionWorkload(),
    });
    expect(result).toMatchObject({ ok: false, code: "invalid-pricing-config" });
    expect(fetchImpl).not.toHaveBeenCalled();
    const state = await operationState(t, fixture);
    expect(state.operation?.state).toBe("prepared");
    expect(state.attempts).toHaveLength(0);
  });

  test("overflow-safe pricing rejects before claim or fetch", async () => {
    const t = init();
    const fixture = await createFixture(t, "openai-overflow-pricing");
    const fetchImpl = vi.fn(async () => providerResponse());
    vi.stubGlobal("fetch", fetchImpl);
    process.env[openai.OPENAI_PRICING_ENV_VARS.inputMicroUsdPerMillion] = "9007199254740991";
    process.env[openai.OPENAI_PRICING_ENV_VARS.maxInputTokens] = "1000000";
    const result = await t.withIdentity(OWNER).action(generateRef, {
      operationId: fixture.operationId,
      identity: OWNER.tokenIdentifier,
      inputVersion: "openai-v1",
      payloadJson: fixture.payloadJson,
      workload: extractionWorkload(),
    });
    expect(result).toMatchObject({ ok: false, code: "invalid-pricing-config" });
    expect(fetchImpl).not.toHaveBeenCalled();
    const state = await operationState(t, fixture);
    expect(state.operation?.state).toBe("prepared");
    expect(state.attempts).toHaveLength(0);
  });

  test("missing API key fails before claim or fetch", async () => {
    const t = init();
    const fixture = await createFixture(t, "openai-missing-key");
    const fetchImpl = vi.fn(async () => providerResponse());
    vi.stubGlobal("fetch", fetchImpl);
    delete process.env[openai.OPENAI_API_KEY_ENV];
    const result = await t.withIdentity(OWNER).action(generateRef, {
      operationId: fixture.operationId,
      identity: OWNER.tokenIdentifier,
      inputVersion: "openai-v1",
      payloadJson: fixture.payloadJson,
      workload: extractionWorkload(),
    });
    expect(result).toMatchObject({ ok: false, code: "provider-unconfigured" });
    expect(fetchImpl).not.toHaveBeenCalled();
    const state = await operationState(t, fixture);
    expect(state.operation?.state).toBe("prepared");
    expect(state.attempts).toHaveLength(0);
  });

  test("undersized and stale reservations make zero provider calls", async () => {
    const undersized = init();
    const small = await createFixture(undersized, "openai-small-reservation", controlledPricing().maxReservationMicroUsd - 1);
    const fetchImpl = vi.fn(async () => providerResponse());
    vi.stubGlobal("fetch", fetchImpl);
    const smallResult = await undersized.withIdentity(OWNER).action(generateRef, {
      operationId: small.operationId,
      identity: OWNER.tokenIdentifier,
      inputVersion: "openai-v1",
      payloadJson: small.payloadJson,
      workload: extractionWorkload(),
    });
    expect(smallResult).toMatchObject({ outcome: "stale", reason: "allowance-exhausted" });
    expect(fetchImpl).not.toHaveBeenCalled();

    const stale = init();
    const old = await createFixture(stale, "openai-stale-reservation");
    await stale.run(async (ctx) => {
      await ctx.db.patch(old.reservationId, { pricingBasis: "stale-basis" });
    });
    const staleResult = await stale.withIdentity(OWNER).action(generateRef, {
      operationId: old.operationId,
      identity: OWNER.tokenIdentifier,
      inputVersion: "openai-v1",
      payloadJson: old.payloadJson,
      workload: extractionWorkload(),
    });
    expect(staleResult).toMatchObject({ outcome: "stale", reason: "stale-pricing-basis" });
    expect(fetchImpl).not.toHaveBeenCalled();
  });

  test("duplicate concurrent claim permits one provider fetch", async () => {
    const t = init();
    const first = await createFixture(t, "openai-concurrent-first");
    const calls: unknown[] = [];
    let release: (() => void) | undefined;
    const released = new Promise<void>((resolve) => { release = resolve; });
    vi.stubGlobal("fetch", vi.fn(async (...args: unknown[]) => {
      calls.push(args);
      await released;
      return providerResponse();
    }));
    const firstAction = t.withIdentity(OWNER).action(generateRef, {
      operationId: first.operationId,
      identity: OWNER.tokenIdentifier,
      inputVersion: "openai-v1",
      payloadJson: first.payloadJson,
      workload: extractionWorkload(),
    });
    const deadline = Date.now() + 1_000;
    while (calls.length < 1 && Date.now() < deadline) await new Promise<void>((resolve) => setTimeout(resolve, 1));
    expect(calls).toHaveLength(1);
    const second = await t.withIdentity(OWNER).action(generateRef, {
      operationId: first.operationId,
      identity: OWNER.tokenIdentifier,
      inputVersion: "openai-v1",
      payloadJson: first.payloadJson,
      workload: extractionWorkload(),
    });
    expect(second).toMatchObject({ ok: false, code: "already-claimed" });
    release?.();
    const result = await firstAction;
    expect(result).toMatchObject({ outcome: "completed" });
    expect(calls).toHaveLength(1);
  });

  test("input, payload, and cancellation fences reject before provider fetch", async () => {
    const input = init();
    const inputFixture = await createFixture(input, "openai-input-fence");
    await input.run(async (ctx) => {
      await ctx.db.patch(inputFixture.grantId, { inputVersions: { brief: "openai-v2" } });
    });
    const fetchImpl = vi.fn(async () => providerResponse());
    vi.stubGlobal("fetch", fetchImpl);
    const inputResult = await input.withIdentity(OWNER).action(generateRef, {
      operationId: inputFixture.operationId,
      identity: OWNER.tokenIdentifier,
      inputVersion: "openai-v1",
      payloadJson: inputFixture.payloadJson,
      workload: extractionWorkload(),
    });
    expect(inputResult).toMatchObject({ ok: false });
    expect(fetchImpl).not.toHaveBeenCalled();

    const payload = init();
    const payloadFixture = await createFixture(payload, "openai-payload-fence");
    const payloadResult = await payload.withIdentity(OWNER).action(generateRef, {
      operationId: payloadFixture.operationId,
      identity: OWNER.tokenIdentifier,
      inputVersion: "openai-v1",
      payloadJson: canonicalJson({ query: "tampered payload" }),
      workload: extractionWorkload(),
    });
    expect(payloadResult).toMatchObject({ ok: false, code: "changed-draft" });
    expect(fetchImpl).not.toHaveBeenCalled();
    const payloadState = await operationState(payload, payloadFixture);
    expect(payloadState.operation?.state).toBe("prepared");
    expect(payloadState.attempts).toHaveLength(0);
    expect(payloadState.reservation).toMatchObject({
      state: "open",
      reservedMicroUsd: payloadFixture.pricing.maxReservationMicroUsd,
      spentMicroUsd: 0,
      unresolvedMicroUsd: 0,
    });

    const cancelled = init();
    const cancelledFixture = await createFixture(cancelled, "openai-cancel-fence");
    const cancelResult = await cancelled.withIdentity(OWNER).mutation(
      makeFunctionReference<"mutation", MutationArgs<typeof jobs.cancel>, MutationReturn<typeof jobs.cancel>>("execution/jobs:cancel"),
      { jobId: cancelledFixture.jobId, reason: "controlled cancellation" },
    );
    expect(cancelResult).toMatchObject({ ok: true });
    const cancelledAction = await cancelled.withIdentity(OWNER).action(generateRef, {
      operationId: cancelledFixture.operationId,
      identity: OWNER.tokenIdentifier,
      inputVersion: "openai-v1",
      payloadJson: cancelledFixture.payloadJson,
      workload: extractionWorkload(),
    });
    expect(cancelledAction).toMatchObject({ ok: false });
    expect(fetchImpl).not.toHaveBeenCalled();
  });

  test("same-kind changed workload is blocked before claim with zero provider calls", async () => {
    const t = init();
    const fixture = await createFixture(t, "openai-changed-workload");
    const fetchImpl = vi.fn(async () => providerResponse());
    vi.stubGlobal("fetch", fetchImpl);
    const changedWorkload: openai.CommercialExtractionWorkload = {
      ...extractionWorkload(),
      source: {
        ...extractionWorkload().source,
        content: "Commercial espresso machine. Price EUR 4,999. Delivery in 8 weeks.",
      },
      fields: ["price", "delivery", "installation"],
    };
    const result = await t.withIdentity(OWNER).action(generateRef, {
      operationId: fixture.operationId,
      identity: OWNER.tokenIdentifier,
      inputVersion: "openai-v1",
      payloadJson: fixture.payloadJson,
      workload: changedWorkload,
    });
    expect(result).toMatchObject({ ok: false, code: "stale-input-version" });
    expect(fetchImpl).not.toHaveBeenCalled();
    const state = await operationState(t, fixture);
    expect(state.operation?.state).toBe("prepared");
    expect(state.attempts).toHaveLength(0);
    expect(state.reservation).toMatchObject({
      state: "open",
      reservedMicroUsd: fixture.pricing.maxReservationMicroUsd,
      spentMicroUsd: 0,
      unresolvedMicroUsd: 0,
    });
  });

  test("approved supplier draft uses the exact owner-roleplay envelope", async () => {
    const t = init();
    const fixture = await createSupplierDraftFixture(t, "openai-supplier-success");
    const fetchImpl = vi.fn(async () => providerResponse(draftOutput()));
    vi.stubGlobal("fetch", fetchImpl);
    const result = await t.withIdentity(OWNER).action(generateRef, {
      operationId: fixture.operationId,
      identity: OWNER.tokenIdentifier,
      inputVersion: "openai-v1",
      payloadJson: fixture.payloadJson,
      workload: draftWorkload(),
    });
    expect(result).toMatchObject({ outcome: "completed", output: draftOutput() });
    expect(fetchImpl).toHaveBeenCalledTimes(1);
    const state = await operationState(t, fixture);
    expect(state.operation?.state).toBe("observedSuccess");
  });

  test("changed supplier draft is blocked before claim with zero provider calls", async () => {
    const t = init();
    const fixture = await createSupplierDraftFixture(t, "openai-supplier-changed-workload");
    const fetchImpl = vi.fn(async () => providerResponse(draftOutput()));
    vi.stubGlobal("fetch", fetchImpl);
    const changedWorkload: openai.SupplierDraftWorkload = {
      ...draftWorkload(),
      brief: "Ask for a confirmed installation date and delivery window.",
    };
    const result = await t.withIdentity(OWNER).action(generateRef, {
      operationId: fixture.operationId,
      identity: OWNER.tokenIdentifier,
      inputVersion: "openai-v1",
      payloadJson: fixture.payloadJson,
      workload: changedWorkload,
    });
    expect(result).toMatchObject({ ok: false, code: "stale-input-version" });
    expect(fetchImpl).not.toHaveBeenCalled();
    const state = await operationState(t, fixture);
    expect(state.operation?.state).toBe("prepared");
    expect(state.attempts).toHaveLength(0);
    expect(state.reservation).toMatchObject({
      state: "open",
      reservedMicroUsd: fixture.pricing.maxReservationMicroUsd,
      spentMicroUsd: 0,
      unresolvedMicroUsd: 0,
    });
  });

  test("successful usage records a completed outcome and spends the full reservation", async () => {
    const t = init();
    const fixture = await createFixture(t, "openai-success");
    vi.stubGlobal("fetch", vi.fn(async () => providerResponse()));
    const result = await t.withIdentity(OWNER).action(generateRef, {
      operationId: fixture.operationId,
      identity: OWNER.tokenIdentifier,
      inputVersion: "openai-v1",
      payloadJson: fixture.payloadJson,
      workload: extractionWorkload(),
    });
    expect(result).toMatchObject({ outcome: "completed", usage: { input_tokens: 120, output_tokens: 24 } });
    const state = await operationState(t, fixture);
    expect(state.operation?.state).toBe("observedSuccess");
    expect(state.reservation).toMatchObject({ state: "closed", reservedMicroUsd: 0, spentMicroUsd: fixture.pricing.maxReservationMicroUsd, unresolvedMicroUsd: 0 });
    expect(state.budget).toMatchObject({ reservedMicroUsd: 0, spentMicroUsd: fixture.pricing.maxReservationMicroUsd, unresolvedMicroUsd: 0 });
  });

  test("successful HTTP with malformed or schema-invalid output remains unresolved", async () => {
    const cases: Array<{ readonly name: string; readonly response: () => Response }> = [
      {
        name: "malformed",
        response: () => new Response("not-json", { status: 200 }),
      },
      {
        name: "schema-invalid",
        response: () => providerResponse({
          ...extractionOutput(),
          source: { ...extractionOutput().source, version: "source:other" },
        }),
      },
      {
        name: "model-drift",
        response: () => providerResponse(extractionOutput(), { model: "gpt-5.4-mini" }),
      },
      {
        name: "missing-usage",
        response: () => providerResponse(extractionOutput(), { usage: undefined }),
      },
    ];
    for (const entry of cases) {
      const t = init();
      const fixture = await createFixture(t, `openai-${entry.name}-http`);
      const fetchImpl = vi.fn(async () => entry.response());
      vi.stubGlobal("fetch", fetchImpl);
      const result = await t.withIdentity(OWNER).action(generateRef, {
        operationId: fixture.operationId,
        identity: OWNER.tokenIdentifier,
        inputVersion: "openai-v1",
        payloadJson: fixture.payloadJson,
        workload: extractionWorkload(),
      });
      expect(result, entry.name).toMatchObject({ outcome: "rejected", attempts: 1 });
      expect(fetchImpl, entry.name).toHaveBeenCalledTimes(1);
      const state = await operationState(t, fixture);
      expect(state.operation?.state, entry.name).toBe("outcomeUnknown");
      expect(state.attempts, entry.name).toHaveLength(1);
      expect((state.attempts[0] as { readonly state?: string } | undefined)?.state, entry.name).toBe("outcomeUnknown");
      expect(state.reservation, entry.name).toMatchObject({
        state: "open",
        reservedMicroUsd: 0,
        spentMicroUsd: 0,
        unresolvedMicroUsd: fixture.pricing.maxReservationMicroUsd,
      });
      expect(state.budget, entry.name).toMatchObject({
        reservedMicroUsd: 0,
        spentMicroUsd: 0,
        unresolvedMicroUsd: fixture.pricing.maxReservationMicroUsd,
      });
    }
  });

  test("ambiguous transport records unresolved exposure instead of freeing it", async () => {
    const t = init();
    const fixture = await createFixture(t, "openai-ambiguous");
    vi.stubGlobal("fetch", vi.fn(async () => { throw new Error("controlled transport interruption"); }));
    const result = await t.withIdentity(OWNER).action(generateRef, {
      operationId: fixture.operationId,
      identity: OWNER.tokenIdentifier,
      inputVersion: "openai-v1",
      payloadJson: fixture.payloadJson,
      workload: extractionWorkload(),
    });
    expect(result).toMatchObject({ outcome: "unavailable", reason: "transport-error", attempts: 1 });
    const state = await operationState(t, fixture);
    expect(state.operation?.state).toBe("outcomeUnknown");
    expect(state.reservation).toMatchObject({ state: "open", reservedMicroUsd: 0, spentMicroUsd: 0, unresolvedMicroUsd: fixture.pricing.maxReservationMicroUsd });
    expect(state.budget).toMatchObject({ reservedMicroUsd: 0, spentMicroUsd: 0, unresolvedMicroUsd: fixture.pricing.maxReservationMicroUsd });
  });

  test("OpenAI key is absent from frontend source", async () => {
    const frontend = Object.values(frontendSources).join("\n");
    expect(frontend).not.toContain("OPENAI_API_KEY");
    expect(frontend).not.toContain("controlled-openai-key");
  });
});
