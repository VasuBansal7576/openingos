import { expect, test } from "bun:test";
import { Window as HappyWindow } from "happy-dom";
import { createElement } from "react";
import { act } from "react";
import { createRoot } from "react-dom/client";
import { renderToStaticMarkup } from "react-dom/server";
import App from "../App";
import WorkbenchView from "../Workbench";
import { AdapterAwareApp, appendWorkbenchActivity } from "../main";
import { formatMoney, parseWorkbenchSnapshot, type WorkbenchAction, type WorkbenchActionResult } from "../workbench-state";

const projection = {
  ok: true,
  project: {
    id: "project-w1-1",
    organizationId: "organization-w1-1",
    name: "Northside café",
    visibility: "open",
    location: {
      id: "location-w1-1",
      name: "Northside",
      region: "Netherlands",
      reportingCurrency: "EUR",
      operatingStatus: "open",
    },
    currency: "EUR",
    budgetMinorUnits: 900000,
    needByAt: Date.UTC(2026, 9, 12),
    createdAt: Date.UTC(2026, 8, 1),
  },
  access: {
    role: "approver",
    capabilities: {
      canResearch: true,
      canRecordEvidence: true,
      canRecordQuote: true,
      canCompare: true,
      canCommunicate: true,
      canClarify: true,
    },
  },
  requirements: [{
    id: "requirement-w1-1",
    key: "ESP-01",
    title: "Two-group espresso machine",
    category: "equipment",
    quantity: "1",
    unit: "unit",
    priority: "P0",
    state: "readyForDecision",
    fulfillment: "notOrdered",
    version: 3,
    budgetMinorUnits: 900000,
    currency: "EUR",
    needByAt: Date.UTC(2026, 9, 12),
  }],
  candidates: [{
    id: "candidate-w1-1",
    requirementId: "requirement-w1-1",
    productModel: "Atlas 2G",
    variant: "new · two-group",
    compatibility: "pass",
    conversationState: "quoteReceived",
    vendor: { id: "vendor-w1-1", name: "Harbor Equipment", regions: ["NL"], serviceCoverage: "Service coverage reported for this inquiry" },
    latestValidQuote: {
      id: "quote-w1-1",
      version: "2",
      currency: "EUR",
      lines: [{ lineId: "machine", description: "Atlas 2G", quantity: "1", unitPrice: { currency: "EUR", minorUnits: 795000 } }],
      charges: [
        { chargeId: "charge-equipment", label: "equipment", scope: { kind: "line", lineId: "machine" }, state: { kind: "known", amount: { currency: "EUR", minorUnits: 795000 } } },
        { chargeId: "charge-delivery", label: "delivery", scope: { kind: "quote" }, state: { kind: "included", coveringId: "charge-equipment" } },
        { chargeId: "charge-installation", label: "installation", scope: { kind: "quote" }, state: { kind: "unknown", reason: "Supplier did not confirm installation." } },
      ],
      taxBasis: { kind: "inclusive", basisId: "tax-w1-1" },
      createdAt: Date.UTC(2026, 8, 20),
      provenance: { mode: "recorded", label: "Recorded owner exchange", ownerAuthoredTerms: true },
    },
    evidence: [{
      id: "product-evidence-w1-1",
      field: "installation",
      sourceKind: "owner mailbox exchange",
      capturedAt: Date.UTC(2026, 8, 20),
      completeness: "complete",
      verification: "verified",
      freshness: "fresh",
      lastCheckedAt: Date.UTC(2026, 8, 20),
      counterpartyRole: "ownerStandIn",
      executionMode: "recorded",
    }],
    provenance: { mode: "recorded", label: "Recorded owner exchange", ownerAuthoredTerms: true },
  }],
  jobs: [
    { id: "job-queued", kind: "research", status: "queued", createdAt: Date.UTC(2026, 8, 20), updatedAt: Date.UTC(2026, 8, 20), grantVersion: 1, attempts: [] },
    { id: "job-sent", kind: "communication", status: "sent", createdAt: Date.UTC(2026, 8, 20), updatedAt: Date.UTC(2026, 8, 20), grantVersion: 1, attempts: [{ state: "observedSuccess", createdAt: Date.UTC(2026, 8, 20) }] },
    { id: "job-delivered", kind: "communication", status: "delivered", createdAt: Date.UTC(2026, 8, 20), updatedAt: Date.UTC(2026, 8, 20), grantVersion: 1, attempts: [{ state: "observedSuccess", createdAt: Date.UTC(2026, 8, 20), observedAt: Date.UTC(2026, 8, 20) }] },
    { id: "job-unknown", kind: "communication", status: "unknown", createdAt: Date.UTC(2026, 8, 20), updatedAt: Date.UTC(2026, 8, 20), grantVersion: 1, attempts: [{ state: "outcomeUnknown", createdAt: Date.UTC(2026, 8, 20) }] },
    { id: "job-partial", kind: "recovery", status: "partial", createdAt: Date.UTC(2026, 8, 20), updatedAt: Date.UTC(2026, 8, 20), grantVersion: 1, attempts: [{ state: "observedSuccess", createdAt: Date.UTC(2026, 8, 20) }] },
    { id: "job-paused", kind: "recovery", status: "paused", createdAt: Date.UTC(2026, 8, 20), updatedAt: Date.UTC(2026, 8, 20), grantVersion: 1, attempts: [] },
  ],
  decisions: [{ id: "approval-w1-1", kind: "approval", state: "requested", quoteId: "quote-w1-1", createdAt: Date.UTC(2026, 8, 20) }],
  activity: { page: [{ id: "event-w1-1", kind: "quoteRecorded", createdAt: Date.UTC(2026, 8, 20) }], continueCursor: null, isDone: true },
  requirementsTruncated: false,
  candidatesTruncated: false,
  jobsTruncated: false,
  decisionsTruncated: false,
  provenance: { mode: "recorded", label: "Recorded owner exchange", ownerAuthoredTerms: true },
};

test("accepts the exact W1 projection without inventing aggregates or authority", () => {
  const snapshot = parseWorkbenchSnapshot(projection, projection.project.id);
  expect(snapshot?.project.id).toBe(projection.project.id);
  expect(snapshot?.offers[0]?.quote?.comparableTotalMinorUnits).toBeNull();
  expect(snapshot?.committedMinorUnits).toBeNull();
  expect(snapshot?.access.capabilities.canApprove).toBeNull();
  expect(snapshot?.jobs.map((job) => job.delivery)).toEqual(["queued", "sent", "delivered", "unknown", "partial", "paused"]);
  expect(snapshot?.activity.items[0]?.summary).toBeNull();
});

test("renders a project-scoped workbench from W1 state with honest provenance", () => {
  const snapshot = parseWorkbenchSnapshot(projection, projection.project.id);
  if (snapshot === null) throw new Error("W1 projection should parse");
  const html = renderToStaticMarkup(createElement(WorkbenchView, { loadState: { state: "ready", snapshot } }));
  expect(html).toContain("Everything on the table.");
  expect(html).toContain("Recorded owner exchange");
  expect(html).toContain("Unknown charges stay visible.");
  expect(html).toContain("Unknown");
  expect(html).toContain("Selecting an offer does not place an order.");
  expect(html).not.toContain("owner-supplier@example");
  expect(html).not.toContain("providerId");
});

test("keeps a connected app honest when no projection is available", () => {
  const html = renderToStaticMarkup(createElement(App, {
    backendStatus: "connected",
    workbench: { state: "empty", message: "No authorized project projection is available yet." },
  }));
  expect(html).toContain("Waiting for an authorized project.");
  expect(html).toContain("No vendors, quotes or provider outcomes are shown");
  expect(html).not.toContain("Harbor Equipment");
});

test("rejects malformed, cross-project, and private W1 projection payloads", () => {
  expect(parseWorkbenchSnapshot(projection, "different-project")).toBeNull();
  expect(parseWorkbenchSnapshot({ ...projection, project: { ...projection.project, ownerEmail: "private@example.test" } }, projection.project.id)).toBeNull();
  expect(parseWorkbenchSnapshot({ ...projection, candidates: [{ ...projection.candidates[0], latestValidQuote: { ...projection.candidates[0]!.latestValidQuote!, charges: [{ ...projection.candidates[0]!.latestValidQuote!.charges[0], state: { kind: "known", amount: null } }] } }] }, projection.project.id)).toBeNull();
  expect(parseWorkbenchSnapshot({ ...projection, activity: { ...projection.activity, page: [{ id: "event-w1-1", kind: "quoteRecorded", createdAt: "not-a-time" }] } }, projection.project.id)).toBeNull();
});

test("rejects the obsolete top-level access fixture", () => {
  const { access: _access, ...legacyProjection } = projection;
  expect(parseWorkbenchSnapshot({ ...legacyProjection, effectiveRole: "approver", capabilities: projection.access.capabilities }, projection.project.id)).toBeNull();
});

test("formats unknown money without turning missing charges into zero", () => {
  expect(formatMoney(null, "EUR")).toBe("Unknown");
  expect(formatMoney(795000, "EUR")).toContain("7,950");
});

test("appends later activity pages without replacing the latest snapshot", () => {
  const current = parseWorkbenchSnapshot({
    ...projection,
    project: { ...projection.project, name: "Latest project snapshot" },
    activity: {
      page: [
        { id: "event-first", kind: "quoteRecorded", createdAt: Date.UTC(2026, 8, 22) },
        { id: "event-overlap", kind: "researchStarted", createdAt: Date.UTC(2026, 8, 21) },
      ],
      continueCursor: "activity-cursor-2",
      isDone: false,
    },
  }, projection.project.id);
  const next = parseWorkbenchSnapshot({
    ...projection,
    project: { ...projection.project, name: "Stale page snapshot" },
    activity: {
      page: [
        { id: "event-overlap", kind: "researchStarted", createdAt: Date.UTC(2026, 8, 21) },
        { id: "event-last", kind: "decisionRequested", createdAt: Date.UTC(2026, 8, 20) },
      ],
      continueCursor: null,
      isDone: true,
    },
  }, projection.project.id);
  if (current === null || next === null) throw new Error("activity page fixtures should parse");

  const merged = appendWorkbenchActivity(current, next);
  expect(merged.project.name).toBe("Latest project snapshot");
  expect(merged.offers).toEqual(current.offers);
  expect(merged.jobs).toEqual(current.jobs);
  expect(merged.activity.items.map((item) => item.id)).toEqual(["event-first", "event-overlap", "event-last"]);
  expect(merged.activity.continueCursor).toBeNull();
  expect(merged.activity.isDone).toBe(true);
});

test("keeps concurrent activity pages and live updates from regressing pagination", async () => {
  const dayMs = 86400000;
  const base = Date.UTC(2026, 8, 20);
  const at = (offsetDays: number) => base + offsetDays * dayMs;
  const page = (events: readonly { readonly id: string; readonly at: number }[], continueCursor: string | null, isDone: boolean) => ({
    ...projection,
    activity: {
      page: events.map((event) => ({ id: event.id, kind: "quoteRecorded", createdAt: event.at })),
      continueCursor,
      isDone,
    },
  });

  interface PendingLoad {
    readonly cursor: string | null;
    readonly resolve: (value: unknown) => void;
    readonly reject: (error: unknown) => void;
  }
  const loads: PendingLoad[] = [];
  let liveListener: ((snapshot: unknown) => void) | null = null;
  const adapter = {
    load: (_projectId: string, cursor?: string | null) => new Promise<unknown>((resolve, reject) => {
      loads.push({ cursor: cursor ?? null, resolve, reject });
    }),
    subscribe: (_projectId: string, onSnapshot: (snapshot: unknown) => void, _onError: (error: unknown) => void) => {
      liveListener = onSnapshot;
      return () => {
        liveListener = null;
      };
    },
    act: async () => ({ ok: true }),
  };

  const dom = new HappyWindow({ url: "https://openingos.test/" });
  const previousWindow = globalThis.window;
  const previousDocument = globalThis.document;
  const previousNavigator = globalThis.navigator;
  const actEnvironment = globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean };
  const previousActEnvironment = actEnvironment.IS_REACT_ACT_ENVIRONMENT;
  const browserGlobals = globalThis as unknown as { window: unknown; document: unknown; navigator: unknown };
  browserGlobals.window = dom as unknown as globalThis.Window;
  browserGlobals.document = dom.document as unknown as globalThis.Document;
  browserGlobals.navigator = dom.navigator as unknown as globalThis.Navigator;
  actEnvironment.IS_REACT_ACT_ENVIRONMENT = true;
  const container = dom.document.createElement("div");
  dom.document.body.append(container);
  const root = createRoot(container as unknown as globalThis.Element);
  const findLoadMore = (): HTMLButtonElement | undefined => {
    const button = Array.from(container.querySelectorAll("button")).find((candidate) => candidate.textContent?.includes("Load older activity"));
    return button === undefined ? undefined : (button as unknown as HTMLButtonElement);
  };
  const resolveLoad = async (index: number, payload: unknown) => {
    const pending = loads[index];
    if (pending === undefined) throw new Error(`activity load ${index} was never dispatched`);
    await act(async () => {
      pending.resolve(payload);
    });
  };

  try {
    await act(async () => {
      root.render(createElement(AdapterAwareApp, {
        backendStatus: "connected",
        onRetry: () => undefined,
        projectId: "project-w1-1",
        workbenchAdapter: adapter,
      }));
    });
    expect(loads.length).toBe(1);
    await resolveLoad(0, page([{ id: "event-head-1", at: at(4) }], "activity-cursor-1", false));
    if (findLoadMore() === undefined) throw new Error("Load older activity should be available after the head page");

    // A live projection refresh arrives before the user paginates.
    await act(async () => {
      liveListener?.(page([
        { id: "event-live-0", at: at(5) },
        { id: "event-head-1", at: at(4) },
      ], "activity-cursor-1", false));
    });
    if (liveListener === null) throw new Error("workbench adapter should stay subscribed");

    // Two concurrent "Load older activity" requests share the same cursor.
    await act(async () => {
      findLoadMore()?.click();
    });
    await act(async () => {
      findLoadMore()?.click();
    });
    expect(loads.length).toBe(3);
    expect(loads[1]?.cursor).toBe("activity-cursor-1");
    expect(loads[2]?.cursor).toBe("activity-cursor-1");

    // The newer request resolves first and finishes pagination.
    await resolveLoad(2, page([{ id: "event-tail-new", at: at(3) }], null, true));
    expect(findLoadMore()).toBeUndefined();

    // The older request resolves last with a stale cursor and a repeated head
    // item: it must contribute only its unseen tail item without regressing
    // the finished cursor or duplicating the head item.
    await resolveLoad(1, page([
      { id: "event-head-1", at: at(4) },
      { id: "event-tail-old", at: at(2) },
    ], "activity-cursor-stale", false));
    expect(findLoadMore()).toBeUndefined();
    expect(container.querySelectorAll(".wb-activity-item").length).toBe(4);

    await act(async () => {
      const recovery = Array.from(container.querySelectorAll("button")).find((candidate) => candidate.textContent?.includes("Recovery"));
      if (recovery === undefined) throw new Error("Recovery tab not found");
      recovery.click();
    });
    const story = Array.from(container.querySelectorAll(".wb-recovery-story > div"));
    expect(story.length).toBe(4);
    expect(new Set(story.map((entry) => entry.textContent ?? "")).size).toBe(4);
  } finally {
    await act(async () => {
      root.unmount();
    });
    browserGlobals.window = previousWindow;
    browserGlobals.document = previousDocument;
    browserGlobals.navigator = previousNavigator;
    if (previousActEnvironment === undefined) delete actEnvironment.IS_REACT_ACT_ENVIRONMENT;
    else actEnvironment.IS_REACT_ACT_ENVIRONMENT = previousActEnvironment;
  }
});
test("places activity pagination in the activity area instead of supplier results", () => {
  const snapshot = parseWorkbenchSnapshot({
    ...projection,
    activity: {
      ...projection.activity,
      continueCursor: "activity-cursor-2",
      isDone: false,
    },
  }, projection.project.id);
  if (snapshot === null) throw new Error("W1 projection should parse");
  const html = renderToStaticMarkup(createElement(WorkbenchView, {
    loadState: { state: "ready", snapshot },
    onLoadMore: () => undefined,
  }));
  expect(html).toContain("Load older activity");
  expect(html).not.toContain("Load more results");
  expect(html.indexOf("Load older activity")).toBeGreaterThan(html.indexOf("Activity with evidence."));
});

test("disables every mutation control while reconnecting and resumes after a fresh snapshot", async () => {
  const parsed = parseWorkbenchSnapshot(projection, projection.project.id);
  if (parsed === null) throw new Error("W1 projection should parse");
  const snapshot = {
    ...parsed,
    access: {
      ...parsed.access,
      capabilities: {
        ...parsed.access.capabilities,
        canApprove: true,
        canResolveRisk: true,
      },
    },
    decisions: parsed.decisions.map((decision) => ({ ...decision, evidenceIds: ["product-evidence-w1-1"] })),
    jobs: parsed.jobs.map((job, index) => index === 0 ? { ...job, state: "queued" } : job),
  };
  const dom = new HappyWindow({ url: "https://openingos.test/" });
  const previousWindow = globalThis.window;
  const previousDocument = globalThis.document;
  const previousNavigator = globalThis.navigator;
  const actEnvironment = globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean };
  const previousActEnvironment = actEnvironment.IS_REACT_ACT_ENVIRONMENT;
  const browserGlobals = globalThis as unknown as { window: unknown; document: unknown; navigator: unknown };
  browserGlobals.window = dom as unknown as globalThis.Window;
  browserGlobals.document = dom.document as unknown as globalThis.Document;
  browserGlobals.navigator = dom.navigator as unknown as globalThis.Navigator;
  actEnvironment.IS_REACT_ACT_ENVIRONMENT = true;
  const container = dom.document.createElement("div");
  dom.document.body.append(container);
  const actionCalls: string[] = [];
  const onAction = (action: WorkbenchAction): WorkbenchActionResult => {
    actionCalls.push(action.type);
    return { ok: false, message: "controlled test refusal" };
  };
  const root = createRoot(container as unknown as globalThis.Element);
  const findButton = (label: string): HTMLButtonElement => {
    const button = Array.from(container.querySelectorAll("button")).find((candidate) => candidate.textContent?.includes(label));
    if (!(button instanceof dom.window.HTMLButtonElement)) throw new Error(`Button not found: ${label}`);
    return button as unknown as HTMLButtonElement;
  };
  const clickTab = async (label: string) => {
    await act(async () => {
      findButton(label).click();
    });
  };

  try {
    await act(async () => {
      root.render(createElement(WorkbenchView, { loadState: { state: "reconnecting", lastKnown: snapshot }, onAction }));
    });
    expect(findButton("Start bounded research").disabled).toBe(true);
    await act(async () => {
      findButton("Review quote").click();
    });
    expect(findButton("Select exact quote").disabled).toBe(true);
    expect(actionCalls).toEqual([]);
    await act(async () => {
      const closeButton = container.querySelector('button[aria-label="Close decision review"]') as unknown as HTMLButtonElement | null;
      if (closeButton === null) throw new Error("Decision review close button not found");
      closeButton.click();
    });
    await clickTab("Inbox");
    expect(findButton("Approve this decision").disabled).toBe(true);
    expect(findButton("Retry bounded branch").disabled).toBe(true);
    expect(findButton("Cancel").disabled).toBe(true);
    await clickTab("Recovery");
    expect(findButton("Retry bounded branch").disabled).toBe(true);
    expect(actionCalls).toEqual([]);

    await act(async () => {
      root.render(createElement(WorkbenchView, { loadState: { state: "ready", snapshot }, onAction }));
    });
    await clickTab("Project");
    expect(findButton("Start bounded research").disabled).toBe(false);
    await act(async () => {
      findButton("Start bounded research").click();
    });
    expect(actionCalls).toEqual(["startResearch"]);
  } finally {
    await act(async () => {
      root.unmount();
    });
    browserGlobals.window = previousWindow;
    browserGlobals.document = previousDocument;
    browserGlobals.navigator = previousNavigator;
    if (previousActEnvironment === undefined) delete actEnvironment.IS_REACT_ACT_ENVIRONMENT;
    else actEnvironment.IS_REACT_ACT_ENVIRONMENT = previousActEnvironment;
  }
});
