import { expect, test } from "bun:test";
import type { Watch } from "convex/react";
import { getFunctionName, type FunctionReference } from "convex/server";
import {
  createConvexWorkbenchAdapter,
  createSampleIdempotencyKey,
  researchStartIdempotencyKey,
  type ConvexWorkbenchClient,
} from "../convex-workbench-adapter";
import { parseWorkbenchSnapshot, type WorkbenchAction } from "../workbench-state";
import { payloadHash } from "../../convex/shared/hashing.js";

function projection(projectId = "project-1"): Record<string, unknown> {
  return {
    ok: true,
    project: {
      id: projectId,
      organizationId: "organization-1",
      name: "Northside café",
      visibility: "open",
      currency: "EUR",
      budgetMinorUnits: null,
      needByAt: null,
      createdAt: 1,
    },
    access: {
      role: "viewer",
      capabilities: {
        canResearch: false,
        canRecordEvidence: false,
        canRecordQuote: false,
        canCompare: true,
        canCommunicate: false,
        canClarify: false,
        canApprove: false,
        canOpenServiceCase: false,
      },
    },
    requirements: [],
    requirementsTruncated: false,
    candidates: [],
    candidatesTruncated: false,
    jobs: [],
    jobsTruncated: false,
    decisions: [],
    decisionsTruncated: false,
    equipment: { assets: [], assetsTruncated: false },
    activity: { page: [], continueCursor: null, isDone: true },
    provenance: { mode: "unknown", label: "No supplier terms", ownerAuthoredTerms: false },
  };
}

function actionProjection(projectId = "project-1", requirementVersion = 4): Record<string, unknown> {
  return {
    ...projection(projectId),
    access: {
      role: "approver",
      capabilities: {
        canResearch: true,
        canRecordEvidence: false,
        canRecordQuote: false,
        canCompare: true,
        canCommunicate: false,
        canClarify: false,
        canApprove: true,
        canOpenServiceCase: true,
      },
    },
    requirements: [{
      id: "requirement-1",
      key: "REQ-1",
      title: "Two-group espresso machine",
      category: "equipment",
      quantity: "2",
      unit: "piece",
      priority: "P0",
      state: "readyForDecision",
      fulfillment: "notOrdered",
      version: requirementVersion,
      budgetMinorUnits: null,
      needByAt: null,
    }],
    candidates: [{
      id: "candidate-1",
      requirementId: "requirement-1",
      productModel: "Atlas 2G",
      variant: "new",
      compatibility: "pass",
      conversationState: "quoteReceived",
      vendor: { id: "vendor-1", name: "Harbor Equipment", regions: ["NL"], serviceCoverage: "NL" },
      latestValidQuote: {
        id: "quote-1",
        version: "v1",
        currency: "EUR",
        lines: [{ lineId: "machine", description: "Atlas 2G", quantity: "2", unit: "piece", unitPrice: { currency: "EUR", minorUnits: 795000 } }],
        charges: [],
        taxBasis: { kind: "inclusive", basisId: "tax-1" },
        createdAt: 1,
        provenance: { mode: "recorded", label: "Recorded terms", ownerAuthoredTerms: false },
        currentness: "current",
        superseded: false,
        totalMinorUnits: 1590000,
        comparableTotalMinorUnits: 1590000,
      },
      evidence: [],
      provenance: { mode: "recorded", label: "Recorded terms", ownerAuthoredTerms: false },
    }],
    jobs: [{ id: "job-1", kind: "research", state: "queued", status: "queued", cancellable: true, createdAt: 1, updatedAt: 1, grantVersion: 1, attempts: [] }],
    decisions: [{ id: "approval-1", kind: "approval", state: "pending", createdAt: 1 }],
  };
}

type MutationCall = { readonly reference: unknown; readonly args: unknown };

function actionClient(
  queryResult: unknown,
  watch: Watch<unknown>,
  calls: MutationCall[],
  mutationResult: unknown,
): ConvexWorkbenchClient {
  return {
    query: async () => queryResult,
    watchQuery: () => watch,
    mutation: async (reference: unknown, args: unknown) => {
      calls.push({ reference, args });
      return mutationResult;
    },
  } as unknown as ConvexWorkbenchClient;
}

function accessibleProjects(projectId = "project-1"): Record<string, unknown> {
  return {
    ok: true,
    projects: [{
      id: projectId,
      organizationId: "organization-1",
      name: "Northside café",
      visibility: "open",
      currency: "EUR",
      createdAt: 1,
      access: {
        role: "viewer",
        capabilities: {
          canResearch: false,
          canRecordEvidence: false,
          canRecordQuote: false,
          canCompare: true,
          canCommunicate: false,
          canClarify: false,
          canApprove: false,
          canOpenServiceCase: false,
        },
      },
    }],
    continueCursor: null,
    isDone: true,
  };
}

function fakeClient(
  queryResult: unknown,
  watch: Watch<unknown>,
  queryArgs: unknown[],
  watchArgs: unknown[],
): ConvexWorkbenchClient {
  return {
    query: async (_reference: unknown, args: unknown) => {
      queryArgs.push(args);
      return queryResult;
    },
    watchQuery: (_reference: unknown, args: unknown) => {
      watchArgs.push(args);
      return watch;
    },
  } as unknown as ConvexWorkbenchClient;
}

function controlledWatch(read: () => unknown): {
  readonly watch: Watch<unknown>;
  readonly emit: () => void;
  readonly unsubscribeCount: () => number;
} {
  let listener: (() => void) | null = null;
  let unsubscribeCalls = 0;
  const watch = {
    localQueryResult: read,
    onUpdate: (callback: () => void) => {
      listener = callback;
      return () => {
        unsubscribeCalls += 1;
        listener = null;
      };
    },
  } as unknown as Watch<unknown>;
  return {
    watch,
    emit: () => listener?.(),
    unsubscribeCount: () => unsubscribeCalls,
  };
}

test("wires the bounded project discovery query and validates a W1 projection load", async () => {
  const queryArgs: unknown[] = [];
  const queryReferences: FunctionReference<"query">[] = [];
  const watchArgs: unknown[] = [];
  const controls = controlledWatch(() => projection());
  const responses: unknown[] = [accessibleProjects(), projection()];
  const client = {
    query: async (reference: FunctionReference<"query">, args: unknown) => {
      queryReferences.push(reference);
      queryArgs.push(args);
      return responses.shift() ?? null;
    },
    watchQuery: (_reference: unknown, args: unknown) => {
      watchArgs.push(args);
      return controls.watch;
    },
  } as unknown as ConvexWorkbenchClient;
  const adapter = createConvexWorkbenchAdapter(client);

  await expect(adapter.discoverProject()).resolves.toBe("project-1");
  expect(queryArgs[0]).toEqual({ limit: 1 });

  const loaded = await adapter.load("project-1");
  expect(loaded).toEqual(projection());
  expect(queryArgs[1]).toEqual({ projectId: "project-1", limit: 12 });
  expect(queryReferences.map((reference) => getFunctionName(reference))).toEqual([
    "workbench/projection:listAccessibleProjects",
    "workbench/projection:getProjection",
  ]);
  expect(watchArgs).toHaveLength(0);
});

test("follows native project-list cursors until a later accessible project is found", async () => {
  const queryArgs: unknown[] = [];
  const pages: unknown[] = [
    { ok: true, projects: [], continueCursor: "project-cursor-1", isDone: false },
    { ok: true, projects: [], continueCursor: "project-cursor-2", isDone: false },
    accessibleProjects("project-later"),
  ];
  const adapter = createConvexWorkbenchAdapter({
    query: async (_reference: unknown, args: unknown) => {
      queryArgs.push(args);
      return pages.shift() ?? null;
    },
    watchQuery: () => controlledWatch(() => projection()).watch,
  } as unknown as ConvexWorkbenchClient);

  await expect(adapter.discoverProject()).resolves.toBe("project-later");
  expect(queryArgs).toEqual([
    { limit: 1 },
    { cursor: "project-cursor-1", limit: 1 },
    { cursor: "project-cursor-2", limit: 1 },
  ]);
});

test("stops project discovery on a repeated cursor or bounded page limit", async () => {
  const repeatedArgs: unknown[] = [];
  const repeated = createConvexWorkbenchAdapter({
    query: async (_reference: unknown, args: unknown) => {
      repeatedArgs.push(args);
      return { ok: true, projects: [], continueCursor: "same-cursor", isDone: false };
    },
    watchQuery: () => controlledWatch(() => projection()).watch,
  } as unknown as ConvexWorkbenchClient);
  await expect(repeated.discoverProject()).rejects.toThrow("repeated accessible-project cursor");
  expect(repeatedArgs).toHaveLength(2);

  let pageNumber = 0;
  const boundedArgs: unknown[] = [];
  const bounded = createConvexWorkbenchAdapter({
    query: async (_reference: unknown, args: unknown) => {
      boundedArgs.push(args);
      pageNumber += 1;
      return { ok: true, projects: [], continueCursor: `cursor-${pageNumber}`, isDone: false };
    },
    watchQuery: () => controlledWatch(() => projection()).watch,
  } as unknown as ConvexWorkbenchClient);
  await expect(bounded.discoverProject()).rejects.toThrow("page safety limit");
  expect(boundedArgs).toHaveLength(32);
});

test("rejects malformed and cross-project projections at the adapter boundary", async () => {
  const queryArgs: unknown[] = [];
  const watchArgs: unknown[] = [];
  const controls = controlledWatch(() => projection());
  let result: unknown = projection();
  const client = {
    query: async (_reference: unknown, args: unknown) => {
      queryArgs.push(args);
      return result;
    },
    watchQuery: (_reference: unknown, args: unknown) => {
      watchArgs.push(args);
      return controls.watch;
    },
  } as unknown as ConvexWorkbenchClient;
  const adapter = createConvexWorkbenchAdapter(client);

  await expect(adapter.load("project-1")).resolves.toEqual(projection());
  result = projection("different-project");
  await expect(adapter.load("project-1")).resolves.toBeNull();
  result = { ...projection(), activity: { page: [{ id: "event-1", kind: "quoteRecorded", createdAt: "not-a-time" }], continueCursor: null, isDone: true } };
  await expect(adapter.load("project-1")).resolves.toBeNull();
  expect(queryArgs).toHaveLength(3);
  expect(watchArgs).toHaveLength(0);
});

test("refreshes reactively, unsubscribes, and disposes the client-owned subscription", async () => {
  let current: unknown = projection();
  const controls = controlledWatch(() => current);
  const queryArgs: unknown[] = [];
  const watchArgs: unknown[] = [];
  const adapter = createConvexWorkbenchAdapter(fakeClient(null, controls.watch, queryArgs, watchArgs));
  const snapshots: unknown[] = [];
  const errors: unknown[] = [];
  const subscribe = adapter.subscribe;
  if (subscribe === undefined) throw new Error("The Convex adapter must expose a subscription.");
  const unsubscribe = subscribe("project-1", (snapshot) => snapshots.push(snapshot), (error) => errors.push(error));

  expect(snapshots).toHaveLength(1);
  expect(errors).toHaveLength(0);
  expect(watchArgs[0]).toEqual({ projectId: "project-1", limit: 12 });

  current = projection("different-project");
  controls.emit();
  expect(snapshots).toHaveLength(1);
  expect(errors).toHaveLength(1);

  current = projection();
  controls.emit();
  expect(snapshots).toHaveLength(2);

  unsubscribe();
  current = projection();
  controls.emit();
  expect(snapshots).toHaveLength(2);
  expect(controls.unsubscribeCount()).toBe(1);

  const secondControls = controlledWatch(() => projection());
  const secondAdapter = createConvexWorkbenchAdapter(fakeClient(null, secondControls.watch, [], []));
  if (secondAdapter.subscribe === undefined) throw new Error("The Convex adapter must expose a subscription.");
  secondAdapter.subscribe("project-1", () => {}, () => {});
  secondAdapter.dispose();
  expect(secondControls.unsubscribeCount()).toBe(1);
});

test("keeps unsupported actions explicitly unavailable without querying or sending", async () => {
  const queryArgs: unknown[] = [];
  const watchArgs: unknown[] = [];
  const controls = controlledWatch(() => projection());
  const adapter = createConvexWorkbenchAdapter(fakeClient(accessibleProjects(), controls.watch, queryArgs, watchArgs));

  await expect(adapter.act({ type: "startResearch", projectId: "project-1" })).resolves.toEqual({
    ok: false,
    message: "This action requires a current validated project projection. Nothing was sent.",
  });
  await expect(adapter.act({ type: "retryJob", projectId: "project-1", jobId: "job-1" })).resolves.toEqual({
    ok: false,
    message: "Retry is unavailable because no safe retry contract is configured. Nothing was sent.",
  });
  expect(queryArgs).toHaveLength(0);
  expect(watchArgs).toHaveLength(0);
});

test("records the exact selection payload and refreshes the basis after a mutation", async () => {
  const calls: MutationCall[] = [];
  const controls = controlledWatch(() => actionProjection());
  const adapter = createConvexWorkbenchAdapter(actionClient(
    actionProjection(),
    controls.watch,
    calls,
    { ok: true, selectionId: "selection-1", deduplicated: false },
  ));

  await adapter.load("project-1");
  await expect(adapter.act({ type: "selectOffer", projectId: "project-1", offerId: "candidate-1", quoteId: "quote-1", quoteVersion: "v1" })).resolves.toEqual({
    ok: true,
    message: "Selection recorded by the server; no order was placed.",
  });
  expect(calls).toHaveLength(1);
  expect(getFunctionName(calls[0]?.reference as FunctionReference<"mutation">)).toBe("domain/decisions:recordSelection");
  expect(calls[0]?.args).toEqual({
    organizationId: "organization-1",
    projectId: "project-1",
    requirementId: "requirement-1",
    candidateId: "candidate-1",
    quoteId: "quote-1",
    quoteVersion: "v1",
    selectionLines: [{ quoteLineId: "machine", quantity: "2", unit: "piece" }],
    requirementVersion: 4,
  });

  await expect(adapter.act({ type: "selectOffer", projectId: "project-1", offerId: "candidate-1", quoteId: "quote-1", quoteVersion: "v1" })).resolves.toEqual({
    ok: true,
    message: "Selection recorded by the server; no order was placed.",
  });
  expect(calls).toHaveLength(2);

  await adapter.load("project-1");
  await adapter.act({ type: "selectOffer", projectId: "project-1", offerId: "candidate-1", quoteId: "quote-1", quoteVersion: "v1" });
  expect(calls).toHaveLength(3);
});

test("approves only a normalized pending approval and surfaces server denial text", async () => {
  const calls: MutationCall[] = [];
  const controls = controlledWatch(() => actionProjection());
  const adapter = createConvexWorkbenchAdapter(actionClient(
    actionProjection(),
    controls.watch,
    calls,
    { ok: false, code: "denied-capability", message: "approval denied by server" },
  ));

  await adapter.load("project-1");
  await expect(adapter.act({ type: "approveDecision", projectId: "project-1", decisionId: "approval-1" })).resolves.toEqual({
    ok: false,
    message: "approval denied by server",
  });
  expect(calls).toHaveLength(1);
  expect(getFunctionName(calls[0]?.reference as FunctionReference<"mutation">)).toBe("domain/decisions:decideApproval");
  expect(calls[0]?.args).toEqual({
    organizationId: "organization-1",
    projectId: "project-1",
    approvalId: "approval-1",
    decision: "approved",
  });
});

test("cancels only a projected cancellable job", async () => {
  const calls: MutationCall[] = [];
  const controls = controlledWatch(() => actionProjection());
  const adapter = createConvexWorkbenchAdapter(actionClient(
    actionProjection(),
    controls.watch,
    calls,
    { ok: true, state: "cancelling", complete: false },
  ));

  await adapter.load("project-1");
  await expect(adapter.act({ type: "cancelJob", projectId: "project-1", jobId: "job-1" })).resolves.toEqual({
    ok: true,
    message: "Cancellation queued by the server.",
  });
  expect(calls).toHaveLength(1);
  expect(getFunctionName(calls[0]?.reference as FunctionReference<"mutation">)).toBe("execution/jobs:cancel");
  expect(calls[0]?.args).toEqual({ jobId: "job-1", reason: "Cancelled from the purchasing workbench" });

  await expect(adapter.act({ type: "cancelJob", projectId: "project-1", jobId: "job-1" })).resolves.toEqual({
    ok: true,
    message: "Cancellation queued by the server.",
  });
  expect(calls).toHaveLength(2);
});

test("starts only one supported purchasing research brief and reports queued backend state", async () => {
  const calls: MutationCall[] = [];
  const controls = controlledWatch(() => actionProjection());
  const adapter = createConvexWorkbenchAdapter(actionClient(
    actionProjection(),
    controls.watch,
    calls,
    { ok: true, jobId: "job-2", state: "queued", supportedSegment: "research suppliers", refusedSegments: [] },
  ));

  await adapter.load("project-1");
  const result = await adapter.act({ type: "startResearch", projectId: "project-1" });
  expect(result).toEqual({
    ok: true,
    message: "Research queued by the server; provider outcome is still pending.",
  });
  expect(calls).toHaveLength(1);
  expect(getFunctionName(calls[0]?.reference as FunctionReference<"mutation">)).toBe("execution/jobs:start");
  expect(calls[0]?.args).toEqual({
    organizationId: "organization-1",
    projectId: "project-1",
    text: "Research suppliers for purchasing requirement REQ-1: Two-group espresso machine (equipment).",
    operationId: "research.collect",
    kind: "research",
    idempotencyKey: researchStartIdempotencyKey("project-1", "requirement-1", 4),
  });
  expect(result.message).not.toContain("provider succeeded");
});

test("research start payload and key are stable across separate adapter instances", async () => {
  const firstCalls: MutationCall[] = [];
  const secondCalls: MutationCall[] = [];
  const firstControls = controlledWatch(() => actionProjection());
  const secondControls = controlledWatch(() => actionProjection());
  const queued = { ok: true, jobId: "job-2", state: "queued", supportedSegment: "research suppliers", refusedSegments: [] };
  const first = createConvexWorkbenchAdapter(actionClient(actionProjection(), firstControls.watch, firstCalls, queued));
  const second = createConvexWorkbenchAdapter(actionClient(actionProjection(), secondControls.watch, secondCalls, queued));

  await first.load("project-1");
  await second.load("project-1");
  await expect(first.act({ type: "startResearch", projectId: "project-1" })).resolves.toMatchObject({ ok: true });
  await expect(second.act({ type: "startResearch", projectId: "project-1" })).resolves.toMatchObject({ ok: true });

  expect(firstCalls).toHaveLength(1);
  expect(secondCalls).toHaveLength(1);
  expect(secondCalls[0]?.args).toEqual(firstCalls[0]?.args);
  const firstArgs = firstCalls[0]?.args as Record<string, unknown>;
  const secondArgs = secondCalls[0]?.args as Record<string, unknown>;
  const expectedKey = researchStartIdempotencyKey("project-1", "requirement-1", 4);
  expect(firstArgs["idempotencyKey"]).toBe(expectedKey);
  expect(secondArgs["idempotencyKey"]).toBe(expectedKey);
  expect(expectedKey).toBe(`research:${payloadHash({ operationId: "research.collect", projectId: "project-1", requirementId: "requirement-1", requirementVersion: 4 })}`);
  expect(expectedKey).toMatch(/^[A-Za-z0-9:_-]{8,128}$/);
});

test("research start key changes on requirement version or project change", async () => {
  const baseCalls: MutationCall[] = [];
  const versionedCalls: MutationCall[] = [];
  const projectCalls: MutationCall[] = [];
  const queued = { ok: true, jobId: "job-2", state: "queued", supportedSegment: "research suppliers", refusedSegments: [] };
  const base = createConvexWorkbenchAdapter(actionClient(
    actionProjection("project-1", 4),
    controlledWatch(() => actionProjection("project-1", 4)).watch,
    baseCalls,
    queued,
  ));
  const versioned = createConvexWorkbenchAdapter(actionClient(
    actionProjection("project-1", 5),
    controlledWatch(() => actionProjection("project-1", 5)).watch,
    versionedCalls,
    queued,
  ));
  const otherProject = createConvexWorkbenchAdapter(actionClient(
    actionProjection("project-2", 4),
    controlledWatch(() => actionProjection("project-2", 4)).watch,
    projectCalls,
    queued,
  ));

  await base.load("project-1");
  await versioned.load("project-1");
  await otherProject.load("project-2");
  await expect(base.act({ type: "startResearch", projectId: "project-1" })).resolves.toMatchObject({ ok: true });
  await expect(versioned.act({ type: "startResearch", projectId: "project-1" })).resolves.toMatchObject({ ok: true });
  await expect(otherProject.act({ type: "startResearch", projectId: "project-2" })).resolves.toMatchObject({ ok: true });

  const baseKey = (baseCalls[0]?.args as Record<string, unknown>)["idempotencyKey"];
  const versionedKey = (versionedCalls[0]?.args as Record<string, unknown>)["idempotencyKey"];
  const projectKey = (projectCalls[0]?.args as Record<string, unknown>)["idempotencyKey"];
  expect(typeof baseKey).toBe("string");
  expect(typeof versionedKey).toBe("string");
  expect(typeof projectKey).toBe("string");
  expect(versionedKey).not.toBe(baseKey);
  expect(projectKey).not.toBe(baseKey);
  expect(versionedKey).toBe(researchStartIdempotencyKey("project-1", "requirement-1", 5));
  expect(projectKey).toBe(researchStartIdempotencyKey("project-2", "requirement-1", 4));
  expect(versionedKey).toMatch(/^[A-Za-z0-9:_-]{8,128}$/);
  expect(projectKey).toMatch(/^[A-Za-z0-9:_-]{8,128}$/);
});

test("rejects generic research when requirements are truncated without mutation", async () => {
  const calls: MutationCall[] = [];
  const truncated = { ...actionProjection(), requirementsTruncated: true };
  const controls = controlledWatch(() => truncated);
  const adapter = createConvexWorkbenchAdapter(actionClient(truncated, controls.watch, calls, { ok: true, state: "queued" }));
  await adapter.load("project-1");
  await expect(adapter.act({ type: "startResearch", projectId: "project-1" })).resolves.toEqual({
    ok: false,
    message: "Research is unavailable while the project requirements are truncated. Nothing was sent.",
  });
  expect(calls).toHaveLength(0);
});

test("fences concurrent research calls before the first mutation resolves", async () => {
  const calls: MutationCall[] = [];
  const controls = controlledWatch(() => actionProjection());
  let resolveMutation: ((value: unknown) => void) | undefined;
  const mutation = new Promise<unknown>((resolve) => { resolveMutation = resolve; });
  const adapter = createConvexWorkbenchAdapter({
    query: async () => actionProjection(),
    watchQuery: () => controls.watch,
    mutation: async (reference: unknown, args: unknown) => {
      calls.push({ reference, args });
      return mutation;
    },
  } as unknown as ConvexWorkbenchClient);
  await adapter.load("project-1");

  const action: WorkbenchAction = { type: "startResearch", projectId: "project-1" };
  const first = adapter.act(action);
  const second = adapter.act(action);
  expect(calls).toHaveLength(1);
  await expect(second).resolves.toEqual({
    ok: false,
    message: "This action is already in progress. Wait for the current server response.",
  });
  resolveMutation?.({ ok: true, jobId: "job-2", state: "queued", supportedSegment: "research suppliers", refusedSegments: [] });
  await expect(first).resolves.toEqual({ ok: true, message: "Research queued by the server; provider outcome is still pending." });
  await expect(adapter.act(action)).resolves.toMatchObject({ ok: true });
  expect(calls).toHaveLength(2);
});

test("keeps a newer watched projection when a mutation resolves later", async () => {
  let current: unknown = actionProjection("project-1", 4);
  const controls = controlledWatch(() => current);
  const queries: unknown[] = [];
  const calls: MutationCall[] = [];
  let resolveMutation: ((value: unknown) => void) | undefined;
  const pendingMutation = new Promise<unknown>((resolve) => { resolveMutation = resolve; });
  const adapter = createConvexWorkbenchAdapter({
    query: async () => {
      queries.push(current);
      return current;
    },
    watchQuery: () => controls.watch,
    mutation: async (reference: unknown, args: unknown) => {
      calls.push({ reference, args });
      return calls.length === 1
        ? pendingMutation
        : { ok: true, selectionId: `selection-${calls.length}`, deduplicated: false };
    },
  } as unknown as ConvexWorkbenchClient);

  await adapter.load("project-1");
  const unsubscribe = adapter.subscribe?.("project-1", () => {}, () => {});
  const first = adapter.act({ type: "selectOffer", projectId: "project-1", offerId: "candidate-1", quoteId: "quote-1", quoteVersion: "v1" });

  current = actionProjection("project-1", 5);
  controls.emit();
  resolveMutation?.({ ok: true, selectionId: "selection-1", deduplicated: false });
  await expect(first).resolves.toMatchObject({ ok: true });

  // The watch already supplied the newer mutation basis, so completion must
  // not erase it or dispatch a redundant head query.
  expect(queries).toHaveLength(1);

  await expect(adapter.act({ type: "selectOffer", projectId: "project-1", offerId: "candidate-1", quoteId: "quote-1", quoteVersion: "v1" })).resolves.toMatchObject({ ok: true });
  expect(calls[1]?.args).toMatchObject({ requirementVersion: 5 });
  unsubscribe?.();
});

test("refetches after a successful mutation when no newer watch exists", async () => {
  const responses: unknown[] = [actionProjection("project-1", 4), actionProjection("project-1", 5)];
  const queries: unknown[] = [];
  const calls: MutationCall[] = [];
  const controls = controlledWatch(() => responses[responses.length - 1]);
  const adapter = createConvexWorkbenchAdapter({
    query: async () => {
      queries.push(responses[0]);
      return responses.shift() ?? null;
    },
    watchQuery: () => controls.watch,
    mutation: async (reference: unknown, args: unknown) => {
      calls.push({ reference, args });
      return { ok: true, selectionId: "selection-1", deduplicated: false };
    },
  } as unknown as ConvexWorkbenchClient);

  await adapter.load("project-1");
  await expect(adapter.act({ type: "selectOffer", projectId: "project-1", offerId: "candidate-1", quoteId: "quote-1", quoteVersion: "v1" })).resolves.toMatchObject({ ok: true });
  expect(queries).toHaveLength(2);

  // The post-mutation refetch is the basis for the next action when no watch
  // emission arrived during the mutation.
  await expect(adapter.act({ type: "selectOffer", projectId: "project-1", offerId: "candidate-1", quoteId: "quote-1", quoteVersion: "v1" })).resolves.toMatchObject({ ok: true });
  expect(calls[1]?.args).toMatchObject({ requirementVersion: 5 });
});

test("rejects missing, stale, cross-project, and malformed action inputs without mutation", async () => {
  const calls: MutationCall[] = [];
  const controls = controlledWatch(() => actionProjection());
  let current: unknown = actionProjection();
  const adapter = createConvexWorkbenchAdapter({
    query: async () => current,
    watchQuery: () => controls.watch,
    mutation: async (reference: unknown, args: unknown) => {
      calls.push({ reference, args });
      return { ok: true };
    },
  } as unknown as ConvexWorkbenchClient);

  await expect(adapter.act({ type: "selectOffer", projectId: "project-1", offerId: "candidate-1", quoteId: "quote-1", quoteVersion: "v1" })).resolves.toEqual({
    ok: false,
    message: "This action requires a current validated project projection. Nothing was sent.",
  });
  await adapter.load("project-1");
  await expect(adapter.act({ type: "selectOffer", projectId: "project-2", offerId: "candidate-1", quoteId: "quote-1", quoteVersion: "v1" })).resolves.toEqual({
    ok: false,
    message: "This action requires a current validated project projection. Nothing was sent.",
  });
  current = { ...actionProjection(), activity: { page: [{ id: "event-1", kind: "bad", createdAt: "not-a-time" }], continueCursor: null, isDone: true } };
  await expect(adapter.load("project-1")).resolves.toBeNull();
  await expect(adapter.act({ type: "startResearch", projectId: "project-1" })).resolves.toEqual({
    ok: false,
    message: "This action requires a current validated project projection. Nothing was sent.",
  });
  expect(calls).toHaveLength(0);
});

test("action-specific stale and authority fences make zero mutations", async () => {
  const loadActionAdapter = async (
    value: Record<string, unknown>,
    calls: MutationCall[],
  ): Promise<ReturnType<typeof createConvexWorkbenchAdapter>> => {
    const controls = controlledWatch(() => value);
    const adapter = createConvexWorkbenchAdapter(actionClient(value, controls.watch, calls, { ok: true }));
    await adapter.load("project-1");
    return adapter;
  };

  const staleCalls: MutationCall[] = [];
  const staleAdapter = await loadActionAdapter(actionProjection(), staleCalls);
  await staleAdapter.act({ type: "selectOffer", projectId: "project-1", offerId: "candidate-1", quoteId: "quote-1", quoteVersion: "old-version" });
  await staleAdapter.act({ type: "selectOffer", projectId: "project-1", offerId: "candidate-1", quoteId: "old-quote", quoteVersion: "v1" });
  expect(staleCalls).toHaveLength(0);

  const nonPendingProjection = {
    ...actionProjection(),
    decisions: [{ id: "approval-1", kind: "approval", state: "approved", createdAt: 1 }],
  };
  const approvalCalls: MutationCall[] = [];
  const approvalAdapter = await loadActionAdapter(nonPendingProjection, approvalCalls);
  await approvalAdapter.act({ type: "approveDecision", projectId: "project-1", decisionId: "approval-1" });
  expect(approvalCalls).toHaveLength(0);

  const nonCancellableProjection = {
    ...actionProjection(),
    jobs: [{ id: "job-1", kind: "research", state: "queued", status: "queued", cancellable: false, createdAt: 1, updatedAt: 1, grantVersion: 1, attempts: [] }],
  };
  const cancelCalls: MutationCall[] = [];
  const cancelAdapter = await loadActionAdapter(nonCancellableProjection, cancelCalls);
  await cancelAdapter.act({ type: "cancelJob", projectId: "project-1", jobId: "job-1" });
  expect(cancelCalls).toHaveLength(0);

  const baseProjection = actionProjection();
  const firstRequirement = (baseProjection.requirements as readonly Record<string, unknown>[])[0];
  if (firstRequirement === undefined) throw new Error("action fixture requirement missing");
  const ambiguousProjection = {
    ...baseProjection,
    requirements: [firstRequirement, { ...firstRequirement, id: "requirement-2", key: "REQ-2" }],
  };
  const researchCalls: MutationCall[] = [];
  const researchAdapter = await loadActionAdapter(ambiguousProjection, researchCalls);
  await researchAdapter.act({ type: "startResearch", projectId: "project-1" });
  expect(researchCalls).toHaveLength(0);

  const truncatedProjection = { ...baseProjection, requirementsTruncated: true };
  const truncatedCalls: MutationCall[] = [];
  const truncatedAdapter = await loadActionAdapter(truncatedProjection, truncatedCalls);
  await truncatedAdapter.act({ type: "startResearch", projectId: "project-1" });
  expect(truncatedCalls).toHaveLength(0);
});

test("invalidates action cache on watch errors and unsubscribe while preserving an empty initial watch", async () => {
  let current: unknown = undefined;
  let watchError = false;
  const calls: MutationCall[] = [];
  const controls = controlledWatch(() => {
    if (watchError) throw new Error("reconnect failed");
    return current;
  });
  const adapter = createConvexWorkbenchAdapter(actionClient(actionProjection(), controls.watch, calls, { ok: true }));
  await adapter.load("project-1");
  const errors: unknown[] = [];
  const unsubscribe = adapter.subscribe?.("project-1", () => {}, (error) => errors.push(error));
  expect(errors).toHaveLength(0);
  await expect(adapter.act({ type: "selectOffer", projectId: "project-1", offerId: "candidate-1", quoteId: "quote-1", quoteVersion: "v1" })).resolves.toMatchObject({ ok: true });
  expect(calls).toHaveLength(1);

  await adapter.load("project-1");
  current = actionProjection();
  controls.emit();
  expect(calls).toHaveLength(1);

  await adapter.load("project-1");
  watchError = true;
  controls.emit();
  expect(errors).toHaveLength(1);
  await expect(adapter.act({ type: "startResearch", projectId: "project-1" })).resolves.toMatchObject({ ok: false });
  expect(calls).toHaveLength(1);

  watchError = false;
  current = actionProjection();
  controls.emit();
  const secondUnsubscribe = unsubscribe;
  if (secondUnsubscribe === undefined) throw new Error("subscription should be available");
  secondUnsubscribe();
  await expect(adapter.act({ type: "startResearch", projectId: "project-1" })).resolves.toMatchObject({ ok: false });
  expect(calls).toHaveLength(1);
});

test("a failed subscription setup fences a previously loaded mutation basis", async () => {
  const calls: MutationCall[] = [];
  const errors: unknown[] = [];
  const adapter = createConvexWorkbenchAdapter({
    query: async () => actionProjection(),
    watchQuery: () => {
      throw new Error("watch setup failed");
    },
    mutation: async (reference: unknown, args: unknown) => {
      calls.push({ reference, args });
      return { ok: true };
    },
  } as unknown as ConvexWorkbenchClient);

  await adapter.load("project-1");
  adapter.subscribe?.("project-1", () => {}, (error) => errors.push(error));
  expect(errors).toHaveLength(1);
  await expect(adapter.act({ type: "selectOffer", projectId: "project-1", offerId: "candidate-1", quoteId: "quote-1", quoteVersion: "v1" })).resolves.toMatchObject({ ok: false });
  expect(calls).toHaveLength(0);
});

test("a newer watched projection wins over a late load result", async () => {
  let resolveQuery: ((value: unknown) => void) | undefined;
  const query = new Promise<unknown>((resolve) => { resolveQuery = resolve; });
  let current: unknown = actionProjection("project-1", 4);
  const controls = controlledWatch(() => current);
  const calls: MutationCall[] = [];
  const adapter = createConvexWorkbenchAdapter({
    query: async () => query,
    watchQuery: () => controls.watch,
    mutation: async (reference: unknown, args: unknown) => {
      calls.push({ reference, args });
      return { ok: true };
    },
  } as unknown as ConvexWorkbenchClient);

  const lateLoad = adapter.load("project-1");
  const unsubscribe = adapter.subscribe?.("project-1", () => {}, () => {});
  current = actionProjection("project-1", 5);
  controls.emit();
  resolveQuery?.(actionProjection("project-1", 4));
  await expect(lateLoad).resolves.toBeNull();
  await adapter.act({ type: "selectOffer", projectId: "project-1", offerId: "candidate-1", quoteId: "quote-1", quoteVersion: "v1" });
  expect(calls[0]?.args).toMatchObject({ requirementVersion: 5 });
  unsubscribe?.();
});

test("opens a current projected service case with exact authority and idempotency payload", async () => {
  const calls: MutationCall[] = [];
  const controls = controlledWatch(() => serviceActionProjection());
  let mutationResult: unknown = { ok: false, code: "denied-project", message: "asset service access denied" };
  const adapter = createConvexWorkbenchAdapter({
    query: async () => serviceActionProjection(),
    watchQuery: () => controls.watch,
    mutation: async (reference: unknown, args: unknown) => {
      calls.push({ reference, args });
      return mutationResult;
    },
  } as unknown as ConvexWorkbenchClient);
  const action: WorkbenchAction = {
    type: "openServiceCase",
    projectId: "project-1",
    assetId: "asset-e1-1",
    urgency: "high",
    summary: "  Pressure fault on group head  ",
    idempotencyKey: "case-key-1",
  };

  await adapter.load("project-1");
  await expect(adapter.act(action)).resolves.toEqual({ ok: false, message: "asset service access denied" });
  expect(getFunctionName(calls[0]?.reference as FunctionReference<"mutation">)).toBe("domain/fulfillment:openServiceCase");
  expect(calls[0]?.args).toEqual({
    organizationId: "organization-1",
    projectId: "project-1",
    assetId: "asset-e1-1",
    urgency: "high",
    summary: "Pressure fault on group head",
    idempotencyKey: "case-key-1",
  });

  // An explicit server denial is no-write, so the validated basis remains
  // available for a corrected or retried action without a forced reload.
  await expect(adapter.act(action)).resolves.toMatchObject({ ok: false });
  expect(calls).toHaveLength(2);

  mutationResult = { ok: true, caseId: "case-e1-1", deduplicated: true };
  await expect(adapter.act(action)).resolves.toEqual({
    ok: true,
    message: "Service case already recorded by the server; this submission was deduplicated.",
  });
  expect(calls).toHaveLength(3);
  expect(calls[2]?.args).toEqual(calls[0]?.args);
});

test("rejects viewer, missing, stale, and cross-project service-case inputs without mutation", async () => {
  const calls: MutationCall[] = [];
  const controls = controlledWatch(() => serviceActionProjection());
  const adapter = createConvexWorkbenchAdapter({
    query: async () => serviceActionProjection(),
    watchQuery: () => controls.watch,
    mutation: async (reference: unknown, args: unknown) => {
      calls.push({ reference, args });
      return { ok: true, caseId: "case-e1-1", deduplicated: false };
    },
  } as unknown as ConvexWorkbenchClient);
  const baseAction: WorkbenchAction = { type: "openServiceCase", projectId: "project-1", assetId: "asset-e1-1", urgency: "normal", summary: "Inspect pump", idempotencyKey: "case-key" };

  await expect(adapter.act(baseAction)).resolves.toMatchObject({ ok: false });
  await adapter.load("project-1");
  await expect(adapter.act({ ...baseAction, assetId: "asset-missing" })).resolves.toMatchObject({ ok: false });
  await expect(adapter.act({ ...baseAction, projectId: "project-2" })).resolves.toMatchObject({ ok: false });
  await expect(adapter.act({ ...baseAction, summary: "   " })).resolves.toMatchObject({ ok: false });
  await expect(adapter.act({ ...baseAction, summary: "x".repeat(801) })).resolves.toMatchObject({ ok: false });
  await expect(adapter.act({ ...baseAction, idempotencyKey: "   " })).resolves.toMatchObject({ ok: false });
  expect(calls).toHaveLength(0);

  const viewerCalls: MutationCall[] = [];
  const viewerProjection = { ...serviceActionProjection(), access: projection().access };
  const viewerAdapter = createConvexWorkbenchAdapter({
    query: async () => viewerProjection,
    watchQuery: () => controls.watch,
    mutation: async (reference: unknown, args: unknown) => {
      viewerCalls.push({ reference, args });
      return { ok: true, caseId: "case-e1-1", deduplicated: false };
    },
  } as unknown as ConvexWorkbenchClient);
  await viewerAdapter.load("project-1");
  await expect(viewerAdapter.act(baseAction)).resolves.toMatchObject({ ok: false });
  expect(viewerCalls).toHaveLength(0);
});

function assetFixture(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    id: "asset-e1-1",
    label: "Atlas 2G espresso machine",
    serial: "ATLAS-0042",
    constraints: "Requires water filtration",
    purchaseProvenance: "Order ord-7",
    createdAt: 100,
    documents: [{ kind: "warranty", createdAt: 110 }],
    documentsTruncated: false,
    serviceCases: [{
      id: "case-e1-1",
      urgency: "high",
      summary: "Pressure fault on group head",
      state: "open",
      outcome: "Replaced heating element",
      createdAt: 120,
      updatedAt: 130,
    }],
    serviceCasesTruncated: false,
    ...overrides,
  };
}

function projectionWithAssets(assets: unknown): Record<string, unknown> {
  return { ...projection(), equipment: { assets, assetsTruncated: false } };
}

function serviceActionProjection(projectId = "project-1"): Record<string, unknown> {
  return {
    ...actionProjection(projectId),
    equipment: { assets: [assetFixture()], assetsTruncated: false },
  };
}

async function loadWithAssets(assets: unknown): Promise<unknown> {
  const controls = controlledWatch(() => projectionWithAssets(assets));
  const adapter = createConvexWorkbenchAdapter(fakeClient(projectionWithAssets(assets), controls.watch, [], []));
  return adapter.load("project-1");
}

test("treats empty or whitespace optional display metadata as absent instead of dropping the projection", async () => {
  const payload = projectionWithAssets([
    assetFixture({ serial: "", constraints: "   ", purchaseProvenance: "" }),
    assetFixture({
      id: "asset-e1-2",
      serial: "   ",
      constraints: "",
      purchaseProvenance: "  ",
      serviceCases: [{
        id: "case-e1-2",
        urgency: "low",
        summary: "Annual descale reminder",
        state: "open",
        outcome: "",
        createdAt: 140,
        updatedAt: 140,
      }],
    }),
  ]);
  await expect(loadWithAssets(payload.equipment && (payload.equipment as Record<string, unknown>).assets)).resolves.toEqual(payload);

  const snapshot = parseWorkbenchSnapshot(payload, "project-1");
  if (snapshot === null) throw new Error("Equipment with blank optional fields should parse.");
  expect(snapshot.equipment.assets).toHaveLength(2);
  expect(snapshot.equipment.assets[0]?.serial).toBeNull();
  expect(snapshot.equipment.assets[0]?.constraints).toBeNull();
  expect(snapshot.equipment.assets[0]?.purchaseProvenance).toBeNull();
  expect(snapshot.equipment.assets[0]?.serviceCases[0]?.outcome).toBe("Replaced heating element");
  expect(snapshot.equipment.assets[1]?.serial).toBeNull();
  expect(snapshot.equipment.assets[1]?.constraints).toBeNull();
  expect(snapshot.equipment.assets[1]?.purchaseProvenance).toBeNull();
  expect(snapshot.equipment.assets[1]?.serviceCases[0]?.outcome).toBeNull();
});

test("rejects defined non-string optional display metadata", async () => {
  const seededCase = assetFixture().serviceCases as ReadonlyArray<Record<string, unknown>>;
  await expect(loadWithAssets([assetFixture({ serial: 42 })])).resolves.toBeNull();
  await expect(loadWithAssets([assetFixture({ constraints: { text: "220V" } })])).resolves.toBeNull();
  await expect(loadWithAssets([assetFixture({ purchaseProvenance: false })])).resolves.toBeNull();
  await expect(loadWithAssets([assetFixture({
    serviceCases: [{ ...seededCase[0], outcome: 42 }],
  })])).resolves.toBeNull();
});

function substituteFixture(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    id: "proposal-1",
    requirementId: "requirement-1",
    assessmentId: "assessment-1",
    proposedCandidateId: "candidate-1",
    proposedQuoteId: "quote-1",
    proposedQuoteVersion: "v1",
    state: "pending",
    reason: "Selected revision was superseded; candidate B keeps current terms",
    basisStale: false,
    basisReason: "Proposed quote revision and requirement version are still current.",
    createdAt: 2,
    updatedAt: 2,
    ...overrides,
  };
}

function impactFixture(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    id: "assessment-1",
    requirementId: "requirement-1",
    trigger: "quoteRevision",
    state: "recorded",
    orderImpact: "reviewRequired",
    reason: "Quote v1 was superseded by v2; 1 placed order(s) keep their history and need fresh approval before any substitute",
    quoteVersion: "v2",
    predecessorQuoteVersion: "v1",
    placedOrderCount: 1,
    createdAt: 1,
    ...overrides,
  };
}

function substituteProjection(substitute: Record<string, unknown>, impact: Record<string, unknown>): Record<string, unknown> {
  return {
    ...actionProjection(),
    impacts: [impact],
    impactsTruncated: false,
    substitutes: [substitute],
    substitutesTruncated: false,
  };
}

test("decides a current pending substitute through the authorized impact mutation", async () => {
  const calls: MutationCall[] = [];
  const controls = controlledWatch(() => substituteProjection(substituteFixture(), impactFixture()));
  const adapter = createConvexWorkbenchAdapter(actionClient(
    substituteProjection(substituteFixture(), impactFixture()),
    controls.watch,
    calls,
    { ok: true, decisionApprovalId: "approval-sub-1" },
  ));

  await adapter.load("project-1");
  await expect(adapter.act({ type: "decideSubstituteProposal", projectId: "project-1", proposalId: "proposal-1", decision: "approved" })).resolves.toEqual({
    ok: true,
    message: "Substitute approved by the server; execute it as an explicit new selection.",
  });
  expect(calls).toHaveLength(1);
  expect(getFunctionName(calls[0]?.reference as FunctionReference<"mutation">)).toBe("domain/impact:decideSubstituteProposal");
  expect(calls[0]?.args).toEqual({
    organizationId: "organization-1",
    projectId: "project-1",
    proposalId: "proposal-1",
    decision: "approved",
  });
});

test("stale-basis, decided, viewer, and missing substitute inputs make zero writes", async () => {
  const loadAdapter = async (value: Record<string, unknown>, calls: MutationCall[]) => {
    const controls = controlledWatch(() => value);
    const adapter = createConvexWorkbenchAdapter(actionClient(value, controls.watch, calls, { ok: true }));
    await adapter.load("project-1");
    return adapter;
  };

  const staleCalls: MutationCall[] = [];
  const stale = await loadAdapter(substituteProjection(substituteFixture({ basisStale: true, basisReason: "Proposed quote terms changed; renewed authority required." }), impactFixture()), staleCalls);
  await expect(stale.act({ type: "decideSubstituteProposal", projectId: "project-1", proposalId: "proposal-1", decision: "approved" })).resolves.toMatchObject({ ok: false, message: expect.stringContaining("basis changed") });
  expect(staleCalls).toHaveLength(0);
  // Rejection closes the proposal without relying on the changed terms, so a
  // stale basis still routes the rejection to the authorized backend action.
  const staleRejectCalls: MutationCall[] = [];
  const staleReject = await loadAdapter(substituteProjection(substituteFixture({ basisStale: true, basisReason: "Proposed quote terms changed; renewed authority required." }), impactFixture()), staleRejectCalls);
  await expect(staleReject.act({ type: "decideSubstituteProposal", projectId: "project-1", proposalId: "proposal-1", decision: "rejected" })).resolves.toMatchObject({ ok: true });
  expect(staleRejectCalls).toHaveLength(1);
  expect(staleRejectCalls[0]?.args).toMatchObject({ proposalId: "proposal-1", decision: "rejected" });

  const decidedCalls: MutationCall[] = [];
  const decided = await loadAdapter(substituteProjection(substituteFixture({ state: "approved" }), impactFixture()), decidedCalls);
  await expect(decided.act({ type: "decideSubstituteProposal", projectId: "project-1", proposalId: "proposal-1", decision: "approved" })).resolves.toEqual({ ok: false, message: "This substitute proposal is already approved. Nothing was sent." });
  expect(decidedCalls).toHaveLength(0);

  const viewerCalls: MutationCall[] = [];
  const viewerValue = { ...substituteProjection(substituteFixture(), impactFixture()), access: projection().access };
  const viewer = await loadAdapter(viewerValue, viewerCalls);
  await expect(viewer.act({ type: "decideSubstituteProposal", projectId: "project-1", proposalId: "proposal-1", decision: "rejected" })).resolves.toMatchObject({ ok: false, message: expect.stringContaining("not authorized") });
  expect(viewerCalls).toHaveLength(0);

  const missingCalls: MutationCall[] = [];
  const missing = await loadAdapter(substituteProjection(substituteFixture(), impactFixture()), missingCalls);
  await expect(missing.act({ type: "decideSubstituteProposal", projectId: "project-1", proposalId: "proposal-missing", decision: "approved" })).resolves.toMatchObject({ ok: false });
  expect(missingCalls).toHaveLength(0);
});

test("parses stored impacts and substitutes without inventing outcomes", async () => {
  const payload = substituteProjection(
    substituteFixture(),
    impactFixture({ state: "unknown", orderImpact: "unknown" }),
  );
  const snapshot = parseWorkbenchSnapshot(payload, "project-1");
  if (snapshot === null) throw new Error("E8 projection should parse");
  expect(snapshot.impacts).toHaveLength(1);
  expect(snapshot.impacts[0]?.orderImpact).toBe("unknown");
  expect(snapshot.impacts[0]?.reason).toContain("keep their history");
  expect(snapshot.substitutes[0]?.basisStale).toBe(false);
  expect(snapshot.truncation.impacts).toBe(false);
  expect(snapshot.truncation.substitutes).toBe(false);
  expect(parseWorkbenchSnapshot({ ...payload, impacts: [{ ...impactFixture(), reason: "" }] }, "project-1")).toBeNull();
  expect(parseWorkbenchSnapshot({ ...payload, substitutes: "pending" }, "project-1")).toBeNull();
});

test("routes the exact sample mutation with the bounded opaque key", async () => {
  const calls: MutationCall[] = [];
  const controls = controlledWatch(() => projection());
  const adapter = createConvexWorkbenchAdapter(actionClient(
    projection(),
    controls.watch,
    calls,
    { ok: true, projectId: "project-sample-1", organizationId: "organization-sample-1", deduplicated: false },
  ));
  const result = await adapter.createSample({ idempotencyKey: "sample-key-1" });
  expect(result).toEqual({ ok: true, projectId: "project-sample-1", message: "Sample project created by the server." });
  expect(calls).toHaveLength(1);
  expect(getFunctionName(calls[0]?.reference as FunctionReference<"mutation">)).toBe("domain/sampleProject:createSampleGuestProject");
  expect(calls[0]?.args).toEqual({ idempotencyKey: "sample-key-1" });
});

test("rejects empty and overlong sample keys locally without mutation", async () => {
  const calls: MutationCall[] = [];
  const controls = controlledWatch(() => projection());
  const adapter = createConvexWorkbenchAdapter(actionClient(projection(), controls.watch, calls, { ok: true }));
  await expect(adapter.createSample({ idempotencyKey: "   " })).resolves.toMatchObject({ ok: false });
  await expect(adapter.createSample({ idempotencyKey: `k${"x".repeat(128)}` })).resolves.toMatchObject({ ok: false });
  expect(calls).toHaveLength(0);
});

test("surfaces sample denial text and malformed project ids truthfully", async () => {
  const deniedCalls: MutationCall[] = [];
  const deniedControls = controlledWatch(() => projection());
  const denied = createConvexWorkbenchAdapter(actionClient(
    projection(),
    deniedControls.watch,
    deniedCalls,
    { ok: false, code: "invalid-payload", message: "controlled sample denial" },
  ));
  await expect(denied.createSample({ idempotencyKey: "sample-denied" })).resolves.toEqual({
    ok: false,
    message: "controlled sample denial",
  });
  expect(deniedCalls).toHaveLength(1);

  const malformedCalls: MutationCall[] = [];
  const malformedControls = controlledWatch(() => projection());
  const malformed = createConvexWorkbenchAdapter(actionClient(
    projection(),
    malformedControls.watch,
    malformedCalls,
    { ok: true },
  ));
  await expect(malformed.createSample({ idempotencyKey: "sample-malformed" })).resolves.toMatchObject({ ok: false });
  expect(malformedCalls).toHaveLength(1);
});

test("fences concurrent sample submissions on the same opaque key", async () => {
  const calls: MutationCall[] = [];
  const controls = controlledWatch(() => projection());
  let resolveMutation: ((value: unknown) => void) | undefined;
  const pendingMutation = new Promise<unknown>((resolve) => { resolveMutation = resolve; });
  const adapter = createConvexWorkbenchAdapter({
    query: async () => projection(),
    watchQuery: () => controls.watch,
    mutation: async (reference: unknown, args: unknown) => {
      calls.push({ reference, args });
      return pendingMutation;
    },
  } as unknown as ConvexWorkbenchClient);
  const first = adapter.createSample({ idempotencyKey: "sample-flight" });
  const second = await adapter.createSample({ idempotencyKey: "sample-flight" });
  expect(second).toEqual({
    ok: false,
    message: "This action is already in progress. Wait for the current server response.",
  });
  expect(calls).toHaveLength(1);
  resolveMutation?.({ ok: true, projectId: "project-sample-flight", organizationId: "organization-1", deduplicated: false });
  await expect(first).resolves.toMatchObject({ ok: true, projectId: "project-sample-flight" });
  await expect(adapter.createSample({ idempotencyKey: "sample-flight" })).resolves.toMatchObject({ ok: true });
  expect(calls).toHaveLength(2);
});

test("exposes an opaque browser safe sample key without client identifiers", async () => {
  const first = createSampleIdempotencyKey();
  const second = createSampleIdempotencyKey();
  expect(first.trim().length).toBeGreaterThan(0);
  expect(first).not.toContain("organization");
  expect(first).not.toContain("project-1");
  expect(first).not.toBe(second);
  expect(first).toMatch(/^[A-Za-z0-9:_-]{8,160}$/);
  expect(second).toMatch(/^[A-Za-z0-9:_-]{8,160}$/);
});

test("a server discovery denial rejects as a recoverable error, never an empty workspace", async () => {
  const queryArgs: unknown[] = [];
  const adapter = createConvexWorkbenchAdapter({
    query: async (_reference: unknown, args: unknown) => {
      queryArgs.push(args);
      return { ok: false, code: "forged-identity", message: "unauthenticated" };
    },
    watchQuery: () => controlledWatch(() => projection()).watch,
  } as unknown as ConvexWorkbenchClient);

  await expect(adapter.discoverProject()).rejects.toThrow(
    "Authorized projects could not be discovered (forged-identity: unauthenticated). Retry to re-establish the backend identity.",
  );
  expect(queryArgs).toEqual([{ limit: 1 }]);
});

test("a denial on a later discovery page rejects instead of hiding behind pagination", async () => {
  const pages: unknown[] = [
    { ok: true, projects: [], continueCursor: "project-cursor-1", isDone: false },
    { ok: false, code: "forged-identity", message: "unauthenticated" },
  ];
  const adapter = createConvexWorkbenchAdapter({
    query: async () => pages.shift() ?? null,
    watchQuery: () => controlledWatch(() => projection()).watch,
  } as unknown as ConvexWorkbenchClient);

  await expect(adapter.discoverProject()).rejects.toThrow(/could not be discovered.*forged-identity/);
});

test("retry after a discovery denial succeeds once the server confirms the identity", async () => {
  const pages: unknown[] = [
    { ok: false, code: "forged-identity", message: "unauthenticated" },
    accessibleProjects("project-recovered"),
  ];
  const adapter = createConvexWorkbenchAdapter({
    query: async () => pages.shift() ?? null,
    watchQuery: () => controlledWatch(() => projection()).watch,
  } as unknown as ConvexWorkbenchClient);

  await expect(adapter.discoverProject()).rejects.toThrow(/Retry to re-establish the backend identity/);
  await expect(adapter.discoverProject()).resolves.toBe("project-recovered");
});

test("a denied projection load throws instead of returning an empty projection", async () => {
  const adapter = createConvexWorkbenchAdapter({
    query: async () => ({ ok: false, code: "forged-identity", message: "unauthenticated" }),
    watchQuery: () => controlledWatch(() => projection()).watch,
  } as unknown as ConvexWorkbenchClient);

  await expect(adapter.load("project-1")).rejects.toThrow(
    "The project projection could not be read (forged-identity: unauthenticated). Retry to re-establish the backend identity.",
  );
});
