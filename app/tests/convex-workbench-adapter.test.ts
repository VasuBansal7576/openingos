import { expect, test } from "bun:test";
import type { Watch } from "convex/react";
import { getFunctionName, type FunctionReference } from "convex/server";
import {
  createConvexWorkbenchAdapter,
  type ConvexWorkbenchClient,
} from "../convex-workbench-adapter";
import { parseWorkbenchSnapshot, type WorkbenchAction } from "../workbench-state";

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

test("records the exact selection payload and invalidates the basis after a mutation attempt", async () => {
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
    ok: false,
    message: "This action requires a current validated project projection. Nothing was sent.",
  });
  expect(calls).toHaveLength(1);

  await adapter.load("project-1");
  await adapter.act({ type: "selectOffer", projectId: "project-1", offerId: "candidate-1", quoteId: "quote-1", quoteVersion: "v1" });
  expect(calls).toHaveLength(2);
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
    ok: false,
    message: "This action requires a current validated project projection. Nothing was sent.",
  });
  expect(calls).toHaveLength(1);
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
  });
  expect(result.message).not.toContain("provider succeeded");
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
  await expect(adapter.act(action)).resolves.toMatchObject({ ok: false });
  expect(calls).toHaveLength(1);
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

  // Every attempted mutation invalidates the basis, including denial. A
  // repeated click cannot send again until fresh server state arrives.
  await expect(adapter.act(action)).resolves.toMatchObject({ ok: false });
  expect(calls).toHaveLength(1);

  await adapter.load("project-1");
  mutationResult = { ok: true, caseId: "case-e1-1", deduplicated: true };
  await expect(adapter.act(action)).resolves.toEqual({
    ok: true,
    message: "Service case already recorded by the server; this submission was deduplicated.",
  });
  expect(calls).toHaveLength(2);
  expect(calls[1]?.args).toEqual(calls[0]?.args);
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
