import { expect, test } from "bun:test";
import type { Watch } from "convex/react";
import {
  createConvexWorkbenchAdapter,
  type ConvexWorkbenchClient,
} from "../convex-workbench-adapter";
import { parseWorkbenchSnapshot } from "../workbench-state";

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
  const watchArgs: unknown[] = [];
  const controls = controlledWatch(() => projection());
  const responses: unknown[] = [accessibleProjects(), projection()];
  const client = {
    query: async (_reference: unknown, args: unknown) => {
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
    message: "This workbench action is unavailable until an authority-bearing backend command is configured. Nothing was sent.",
  });
  expect(queryArgs).toHaveLength(0);
  expect(watchArgs).toHaveLength(0);
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
