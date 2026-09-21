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
      canApprove: true,
      canOpenServiceCase: true,
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
      currentness: "current",
      superseded: false,
      totalMinorUnits: null,
      comparableTotalMinorUnits: null,
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
    { id: "job-queued", kind: "research", state: "queued", status: "queued", cancellable: true, createdAt: Date.UTC(2026, 8, 20), updatedAt: Date.UTC(2026, 8, 20), grantVersion: 1, attempts: [] },
    { id: "job-sent", kind: "communication", state: "completed", status: "sent", cancellable: false, createdAt: Date.UTC(2026, 8, 20), updatedAt: Date.UTC(2026, 8, 20), grantVersion: 1, attempts: [{ state: "observedSuccess", createdAt: Date.UTC(2026, 8, 20) }] },
    { id: "job-delivered", kind: "communication", state: "completed", status: "delivered", cancellable: false, createdAt: Date.UTC(2026, 8, 20), updatedAt: Date.UTC(2026, 8, 20), grantVersion: 1, attempts: [{ state: "observedSuccess", createdAt: Date.UTC(2026, 8, 20), observedAt: Date.UTC(2026, 8, 20) }] },
    { id: "job-unknown", kind: "communication", state: "failed", status: "unknown", cancellable: false, createdAt: Date.UTC(2026, 8, 20), updatedAt: Date.UTC(2026, 8, 20), grantVersion: 1, attempts: [{ state: "outcomeUnknown", createdAt: Date.UTC(2026, 8, 20) }] },
    { id: "job-partial", kind: "recovery", state: "partial", status: "partial", cancellable: true, createdAt: Date.UTC(2026, 8, 20), updatedAt: Date.UTC(2026, 8, 20), grantVersion: 1, attempts: [{ state: "observedSuccess", createdAt: Date.UTC(2026, 8, 20) }] },
    { id: "job-paused", kind: "recovery", state: "pausedBudget", status: "paused", cancellable: true, createdAt: Date.UTC(2026, 8, 20), updatedAt: Date.UTC(2026, 8, 20), grantVersion: 1, attempts: [] },
  ],
  decisions: [{ id: "approval-w1-1", kind: "approval", state: "requested", scope: "selection:quote-w1-1", snapshotHash: "snapshot-hash-w1-1", quoteId: "quote-w1-1", createdAt: Date.UTC(2026, 8, 20) }],
  activity: { page: [{ id: "event-w1-1", kind: "quoteRecorded", createdAt: Date.UTC(2026, 8, 20) }], continueCursor: null, isDone: true },
  equipment: { assets: [], assetsTruncated: false },
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
  expect(snapshot?.access.capabilities.canApprove).toBe(true);
  expect(snapshot?.access.capabilities.canOpenServiceCase).toBe(true);
  expect(snapshot?.decisions[0]?.scope).toBe("selection:quote-w1-1");
  expect(snapshot?.decisions[0]?.snapshotHash).toBe("snapshot-hash-w1-1");
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

test("does not claim project-wide readiness from a truncated requirement page", () => {
  const snapshot = parseWorkbenchSnapshot({
    ...projection,
    requirements: [{ ...projection.requirements[0]!, fulfillment: "commissioned", state: "fulfilled" }],
    requirementsTruncated: true,
  }, projection.project.id);
  if (snapshot === null) throw new Error("Truncated W1 projection should parse");

  const html = renderToStaticMarkup(createElement(WorkbenchView, {
    loadState: { state: "ready", snapshot },
  }));
  expect(html).toContain("Readiness unavailable");
  expect(html).toContain("requirements page is truncated");
  expect(html).toContain("complete project scope unavailable");
  expect(html).not.toContain("100%");
  expect(html).not.toContain("P0 blockers stay visible");
});

test("does not display an equal-count readiness percentage without an authoritative result", () => {
  const snapshot = parseWorkbenchSnapshot({
    ...projection,
    requirements: [{ ...projection.requirements[0]!, fulfillment: "commissioned", state: "fulfilled" }],
  }, projection.project.id);
  if (snapshot === null) throw new Error("Completed W1 projection should parse");

  const html = renderToStaticMarkup(createElement(WorkbenchView, {
    loadState: { state: "ready", snapshot },
  }));
  expect(html).toContain("Not assessed");
  expect(html).toContain("authoritative result not supplied");
  expect(html).not.toContain("100%");
});

test("keeps a connected app honest when no projection is available", () => {
  const html = renderToStaticMarkup(createElement(App, {
    backendStatus: "connected",
    workbench: { state: "empty", message: "No authorized project projection is available yet." },
  }));
  expect(html).toContain("Waiting for an authorized project.");
  expect(html).toContain("No vendors, quotes or provider outcomes are shown");
  expect(html).toContain("Everything on the table.");
  expect(html).toContain("wb-connection-paper");
  expect(html).not.toContain("wb-connected-empty");
  expect(html).not.toContain("Harbor Equipment");
});

test("rejects malformed, cross-project, and private W1 projection payloads", () => {
  expect(parseWorkbenchSnapshot(projection, "different-project")).toBeNull();
  expect(parseWorkbenchSnapshot({ ...projection, project: { ...projection.project, ownerEmail: "private@example.test" } }, projection.project.id)).toBeNull();
  expect(parseWorkbenchSnapshot({ ...projection, candidates: [{ ...projection.candidates[0], latestValidQuote: { ...projection.candidates[0]!.latestValidQuote!, charges: [{ ...projection.candidates[0]!.latestValidQuote!.charges[0], state: { kind: "known", amount: null } }] } }] }, projection.project.id)).toBeNull();
  expect(parseWorkbenchSnapshot({ ...projection, jobs: [{ ...projection.jobs[0]!, state: "not-a-server-lifecycle" }] }, projection.project.id)).toBeNull();
  expect(parseWorkbenchSnapshot({ ...projection, activity: { ...projection.activity, page: [{ id: "event-w1-1", kind: "quoteRecorded", createdAt: "not-a-time" }] } }, projection.project.id)).toBeNull();
});

test("rejects the obsolete top-level access fixture", () => {
  const { access: _access, ...legacyProjection } = projection;
  expect(parseWorkbenchSnapshot({ ...legacyProjection, effectiveRole: "approver", capabilities: projection.access.capabilities }, projection.project.id)).toBeNull();
});

test("fails closed when server authority flags are absent or malformed", () => {
  // E4 combined contract: an absent canApprove is honest unrepresented
  // authority (null) and still parses, while a malformed value fails closed.
  const { canApprove: _canApprove, ...withoutApproval } = projection.access.capabilities;
  const snapshot = parseWorkbenchSnapshot({ ...projection, access: { ...projection.access, capabilities: withoutApproval } }, projection.project.id);
  expect(snapshot?.access.capabilities.canApprove).toBeNull();
  expect(parseWorkbenchSnapshot({ ...projection, access: { ...projection.access, capabilities: { ...projection.access.capabilities, canApprove: "yes" } } }, projection.project.id)).toBeNull();
  expect(parseWorkbenchSnapshot({ ...projection, access: { ...projection.access, capabilities: { ...projection.access.capabilities, canOpenServiceCase: "yes" } } }, projection.project.id)).toBeNull();
});

test("formats unknown money without turning missing charges into zero", () => {
  expect(formatMoney(null, "EUR")).toBe("Unknown");
  expect(formatMoney(795000, "EUR")).toContain("7,950");
});

test("keeps the narrow hero heading fluid with word wrapping", async () => {
  const css = await Bun.file(new URL("../styles.css", import.meta.url)).text();
  const narrow = css.slice(css.indexOf("@media (max-width: 480px)"));
  expect(narrow).toMatch(/\.wb-page-heading h1 \{[^}]*clamp\(/);
  expect(narrow).toContain("overflow-wrap: break-word");
});

// -- E4 quote currentness and authoritative comparable total ----------------

function projectionWithCurrentCompleteQuote(): Record<string, unknown> {
  const base = projection as unknown as Record<string, unknown>;
  const candidate = (base.candidates as readonly Record<string, unknown>[])[0]!;
  const quote = candidate.latestValidQuote as Record<string, unknown>;
  return {
    ...base,
    access: withCanApprove(base.access as Record<string, unknown>, true),
    candidates: [{
      ...candidate,
      compatibility: "pass",
      latestValidQuote: {
        ...quote,
        lines: [{ lineId: "machine", description: "Atlas 2G", quantity: "1", unitPrice: { currency: "EUR", minorUnits: 750000 } }],
        charges: [
          { chargeId: "charge-freight", label: "freight", scope: { kind: "quote" }, state: { kind: "known", amount: { currency: "EUR", minorUnits: 60000 } } },
          { chargeId: "charge-installation", label: "installation", scope: { kind: "quote" }, state: { kind: "known", amount: { currency: "EUR", minorUnits: 40000 } } },
        ],
        currentness: "current",
        superseded: false,
        totalMinorUnits: 850000,
        comparableTotalMinorUnits: 850000,
      },
    }],
  };
}

function withCanApprove(access: Record<string, unknown>, value: unknown): Record<string, unknown> {
  return {
    ...access,
    capabilities: {
      ...(access.capabilities as Record<string, unknown>),
      canApprove: value,
    },
  };
}

function withQuoteTotals(payload: Record<string, unknown>, mutate: (quote: Record<string, unknown>) => Record<string, unknown>): Record<string, unknown> {
  const candidates = payload.candidates as readonly Record<string, unknown>[];
  return {
    ...payload,
    candidates: [{
      ...candidates[0]!,
      latestValidQuote: mutate(candidates[0]!.latestValidQuote as Record<string, unknown>),
    }],
  };
}

test("parses the authoritative E4 total only from server-supplied safe integers", () => {
  const snapshot = parseWorkbenchSnapshot(projectionWithCurrentCompleteQuote(), projection.project.id);
  if (snapshot === null) throw new Error("Complete E4 projection should parse");
  const quote = snapshot.offers[0]?.quote;
  expect(quote?.comparableTotalMinorUnits).toBe(850000);
  expect(quote?.totalMinorUnits).toBe(850000);
  expect(quote?.superseded).toBe(false);
  expect(snapshot.access.capabilities.canApprove).toBe(true);
});

test("rejects malformed E4 total and currentness fields instead of synthesizing null", () => {
  const projectId = projection.project.id;
  const withTotals = (mutate: (quote: Record<string, unknown>) => Record<string, unknown>): Record<string, unknown> =>
    withQuoteTotals(projectionWithCurrentCompleteQuote(), mutate);
  expect(parseWorkbenchSnapshot(withTotals((quote) => ({ ...quote, comparableTotalMinorUnits: 850000.5 })), projectId)).toBeNull();
  expect(parseWorkbenchSnapshot(withTotals((quote) => ({ ...quote, comparableTotalMinorUnits: Number.NaN })), projectId)).toBeNull();
  expect(parseWorkbenchSnapshot(withTotals((quote) => ({ ...quote, totalMinorUnits: "850000" })), projectId)).toBeNull();
  expect(parseWorkbenchSnapshot(withTotals(({ totalMinorUnits: _omitted, ...quote }) => quote), projectId)).toBeNull();
  expect(parseWorkbenchSnapshot(withTotals((quote) => ({ ...quote, currentness: "superseded" })), projectId)).toBeNull();
  expect(parseWorkbenchSnapshot(withTotals((quote) => ({ ...quote, superseded: true })), projectId)).toBeNull();
  expect(parseWorkbenchSnapshot(withTotals(({ currentness: _omitted, ...quote }) => quote), projectId)).toBeNull();
  const unauthorized = projectionWithCurrentCompleteQuote();
  expect(parseWorkbenchSnapshot({ ...unauthorized, access: withCanApprove(unauthorized.access as Record<string, unknown>, "yes") }, projectId)).toBeNull();
});

test("rejects ambiguous total relationships between the exact and comparable totals", () => {
  const projectId = projection.project.id;
  // Comparable without an exact total is inconsistent wire data.
  expect(parseWorkbenchSnapshot(withQuoteTotals(projectionWithCurrentCompleteQuote(), (quote) => ({ ...quote, totalMinorUnits: null })), projectId)).toBeNull();
  // A comparable total that disagrees with the exact total is ambiguous.
  expect(parseWorkbenchSnapshot(withQuoteTotals(projectionWithCurrentCompleteQuote(), (quote) => ({ ...quote, totalMinorUnits: 849999 })), projectId)).toBeNull();
  // Negative money totals are rejected at the parser boundary.
  expect(parseWorkbenchSnapshot(withQuoteTotals(projectionWithCurrentCompleteQuote(), (quote) => ({ ...quote, totalMinorUnits: -850000 })), projectId)).toBeNull();
  expect(parseWorkbenchSnapshot(withQuoteTotals(projectionWithCurrentCompleteQuote(), (quote) => ({ ...quote, comparableTotalMinorUnits: -850000 })), projectId)).toBeNull();
});

test("accepts an exact total without a comparable total as complete but not comparable", () => {
  const projectId = projection.project.id;
  const snapshot = parseWorkbenchSnapshot(
    withQuoteTotals(projectionWithCurrentCompleteQuote(), (quote) => ({ ...quote, comparableTotalMinorUnits: null })),
    projectId,
  );
  if (snapshot === null) throw new Error("Complete but not comparable projection should parse");
  const quote = snapshot.offers[0]?.quote;
  expect(quote?.totalMinorUnits).toBe(850000);
  expect(quote?.comparableTotalMinorUnits).toBeNull();
  expect(quote?.superseded).toBe(false);
});

test("rejects a non-safe-integer total without synthesizing null for the backend money", () => {
  const projectId = projection.project.id;
  const snapshot = parseWorkbenchSnapshot(
    withQuoteTotals(projectionWithCurrentCompleteQuote(), (quote) => ({ ...quote, comparableTotalMinorUnits: 850000.25 })),
    projectId,
  );
  expect(snapshot).toBeNull();
});

async function mountSelectionFlow(
  projectionPayload: Record<string, unknown>,
  canApprove: boolean | null,
) {
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
  const root = createRoot(container as unknown as globalThis.Element);
  const findButton = (label: string): HTMLButtonElement => {
    const button = Array.from(container.querySelectorAll("button")).find((candidate) => candidate.textContent?.includes(label));
    if (!(button instanceof dom.window.HTMLButtonElement)) throw new Error(`Button not found: ${label}`);
    return button as unknown as HTMLButtonElement;
  };
  const restore = async () => {
    await act(async () => {
      root.unmount();
    });
    browserGlobals.window = previousWindow;
    browserGlobals.document = previousDocument;
    browserGlobals.navigator = previousNavigator;
    if (previousActEnvironment === undefined) delete actEnvironment.IS_REACT_ACT_ENVIRONMENT;
    else actEnvironment.IS_REACT_ACT_ENVIRONMENT = previousActEnvironment;
  };
  try {
    const snapshot = parseWorkbenchSnapshot(projectionPayload, projection.project.id);
    if (snapshot === null) throw new Error("E4 projection should parse");
    const prepared = canApprove === null
      ? snapshot
      : {
        ...snapshot,
        access: {
          ...snapshot.access,
          capabilities: { ...snapshot.access.capabilities, canApprove },
        },
      };
    await act(async () => {
      root.render(createElement(WorkbenchView, {
        loadState: { state: "ready", snapshot: prepared },
        onAction: (action: WorkbenchAction): WorkbenchActionResult => {
          actionCalls.push(action.type);
          return { ok: false, message: "controlled test: no authority-bearing backend selection route is attached" };
        },
      }));
    });
    await act(async () => {
      findButton("Review quote").click();
    });
    return {
      container,
      findButton,
      actionCalls,
      clickSelect: async () => {
        await act(async () => {
          findButton("Select exact quote").click();
        });
      },
      cleanup: restore,
    };
  } catch (error) {
    await restore();
    throw error;
  }
}

test("a current complete authorized quote becomes selectable with no order or payment claim", async () => {
  const mounted = await mountSelectionFlow(projectionWithCurrentCompleteQuote(), true);
  try {
    expect(mounted.findButton("Select exact quote").disabled).toBe(false);
    await mounted.clickSelect();
    expect(mounted.actionCalls).toEqual(["selectOffer"]);
    expect(mounted.container.textContent).toContain("Selection is not an order.");
    expect(mounted.container.textContent).toContain("No order will be placed. No payment will be taken.");
    expect(mounted.container.textContent).toContain("controlled test: no authority-bearing backend selection route is attached");
  } finally {
    await mounted.cleanup();
  }
});

test("selection stays disabled without approval authority or an authoritative total", async () => {
  const withoutAuthority = await mountSelectionFlow(projectionWithCurrentCompleteQuote(), false);
  try {
    expect(withoutAuthority.findButton("Select exact quote").disabled).toBe(true);
    await withoutAuthority.clickSelect();
    expect(withoutAuthority.actionCalls).toEqual([]);
  } finally {
    await withoutAuthority.cleanup();
  }
  const incompleteQuote = await mountSelectionFlow(projection, true);
  try {
    expect(incompleteQuote.findButton("Select exact quote").disabled).toBe(true);
    await incompleteQuote.clickSelect();
    expect(incompleteQuote.actionCalls).toEqual([]);
    expect(incompleteQuote.container.textContent).toContain("Unknown");
  } finally {
    await incompleteQuote.cleanup();
  }
});

function assetFixture(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    id: "asset-e1-1",
    label: "Atlas 2G espresso machine",
    serial: "ATLAS-0042",
    constraints: "Requires water filtration",
    purchaseProvenance: "Order ord-7, delivered Sep 2026",
    createdAt: Date.UTC(2026, 8, 28),
    documents: [{ kind: "warranty", createdAt: Date.UTC(2026, 8, 28) }],
    documentsTruncated: false,
    serviceCases: [{
      id: "case-e1-1",
      urgency: "high",
      summary: "Pressure fault on group head",
      state: "open",
      outcome: "Technician visit scheduled",
      createdAt: Date.UTC(2026, 9, 2),
      updatedAt: Date.UTC(2026, 9, 3),
    }],
    serviceCasesTruncated: false,
    ...overrides,
  };
}

function projectionWithEquipment(equipment: unknown): Record<string, unknown> {
  return { ...(projection as unknown as Record<string, unknown>), equipment };
}

async function mountEquipmentTab(
  loadState: Parameters<typeof WorkbenchView>[0]["loadState"],
  onAction: (action: WorkbenchAction) => WorkbenchActionResult | Promise<WorkbenchActionResult>,
): Promise<{
  readonly container: HTMLElement;
  readonly findButton: (label: string) => HTMLButtonElement;
  readonly clickTab: (label: string) => Promise<void>;
  readonly cleanup: () => Promise<void>;
}> {
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
  const happyElement = dom.document.createElement("div");
  dom.document.body.append(happyElement);
  const container = happyElement as unknown as HTMLElement;
  const root = createRoot(container as unknown as globalThis.Element);
  await act(async () => {
    root.render(createElement(WorkbenchView, { loadState, onAction }));
  });
  const findButton = (label: string): HTMLButtonElement => {
    const button = Array.from(container.querySelectorAll("button")).find((candidate) => candidate.textContent?.includes(label));
    if (!(button instanceof dom.window.HTMLButtonElement)) throw new Error(`Button not found: ${label}`);
    return button as unknown as HTMLButtonElement;
  };
  return {
    container,
    findButton,
    clickTab: async (label: string) => {
      await act(async () => {
        findButton(label).click();
      });
    },
    cleanup: async () => {
      await act(async () => {
        root.unmount();
      });
      browserGlobals.window = previousWindow;
      browserGlobals.document = previousDocument;
      browserGlobals.navigator = previousNavigator;
      if (previousActEnvironment === undefined) delete actEnvironment.IS_REACT_ACT_ENVIRONMENT;
      else actEnvironment.IS_REACT_ACT_ENVIRONMENT = previousActEnvironment;
    },
  };
}

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
test("discards stale head responses and failures after a live update", async () => {
  const dayMs = 86400000;
  const base = Date.UTC(2026, 8, 20);
  const head = (projectName: string, events: readonly { readonly id: string; readonly at: number }[], continueCursor: string | null, isDone: boolean) => ({
    ...projection,
    project: { ...projection.project, name: projectName },
    activity: {
      page: events.map((event) => ({ id: event.id, kind: "quoteRecorded", createdAt: event.at })),
      continueCursor,
      isDone,
    },
  });

  interface PendingLoad {
    readonly resolve: (value: unknown) => void;
    readonly reject: (error: unknown) => void;
  }
  const loads: PendingLoad[] = [];
  let liveListener: ((snapshot: unknown) => void) | null = null;
  const makeAdapter = () => ({
    load: (_projectId: string, _cursor?: string | null) => new Promise<unknown>((resolve, reject) => {
      loads.push({ resolve, reject });
    }),
    subscribe: (_projectId: string, onSnapshot: (snapshot: unknown) => void, _onError: (error: unknown) => void) => {
      liveListener = onSnapshot;
      return () => {
        liveListener = null;
      };
    },
    act: async () => ({ ok: true }),
  });

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
  const renderApp = async (adapter: ReturnType<typeof makeAdapter>) => {
    await act(async () => {
      root.render(createElement(AdapterAwareApp, {
        backendStatus: "connected",
        onRetry: () => undefined,
        projectId: "project-w1-1",
        workbenchAdapter: adapter,
      }));
    });
  };

  try {
    await renderApp(makeAdapter());
    expect(loads.length).toBe(1);

    // A live update lands while the initial head load is still in flight.
    await act(async () => {
      liveListener?.(head("Live project snapshot", [{ id: "event-live-0", at: base + 5 * dayMs }], "activity-cursor-live", false));
    });
    expect(container.textContent).toContain("Live project snapshot");

    // The older head load now rejects: the newer live projection must stand
    // and no error may overwrite it.
    await act(async () => {
      loads[0]?.reject(new Error("stale controlled head failure"));
    });
    expect(container.textContent).toContain("Live project snapshot");
    expect(container.textContent).not.toContain("could not be read");

    // A refetch is dispatched, superseded by another live update, then
    // resolves with stale head fields and a stale cursor: all of it is
    // discarded without touching the live head, cursor, or pagination.
    await renderApp(makeAdapter());
    expect(loads.length).toBe(2);
    await act(async () => {
      liveListener?.(head("Live project snapshot", [{ id: "event-live-0", at: base + 5 * dayMs }], "activity-cursor-live", false));
    });
    await act(async () => {
      loads[1]?.resolve(head("Stale head snapshot", [{ id: "event-stale-0", at: base + 2 * dayMs }], "activity-cursor-stale", true));
    });
    expect(container.textContent).toContain("Live project snapshot");
    expect(container.textContent).not.toContain("Stale head snapshot");
    const loadMore = Array.from(container.querySelectorAll("button")).find((candidate) => candidate.textContent?.includes("Load older activity"));
    if (loadMore === undefined) throw new Error("live cursor should still offer older activity");
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

test("fences load-older fulfillment and rejection after a same-project adapter replacement", async () => {
  const page = (projectName: string, eventId: string, continueCursor: string | null, isDone: boolean) => ({
    ...projection,
    project: { ...projection.project, name: projectName },
    activity: {
      page: [{ id: eventId, kind: "quoteRecorded", createdAt: Date.UTC(2026, 8, 20) }],
      continueCursor,
      isDone,
    },
  });
  interface PendingLoad {
    readonly resolve: (value: unknown) => void;
    readonly reject: (error: unknown) => void;
  }
  const makeAdapter = () => {
    const loads: PendingLoad[] = [];
    const adapter = {
      load: (_projectId: string, _cursor?: string | null) => new Promise<unknown>((resolve, reject) => {
        loads.push({ resolve, reject });
      }),
      subscribe: (_projectId: string, _onSnapshot: (snapshot: unknown) => void, _onError: (error: unknown) => void) => () => {},
      act: async () => ({ ok: true }),
    };
    return { adapter, loads };
  };
  const first = makeAdapter();
  const replacement = makeAdapter();

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
  const loadMore = () => Array.from(container.querySelectorAll("button")).find((button) => button.textContent?.includes("Load older activity"));

  try {
    await act(async () => {
      root.render(createElement(AdapterAwareApp, {
        backendStatus: "connected",
        onRetry: () => undefined,
        projectId: projection.project.id,
        workbenchAdapter: first.adapter,
      }));
    });
    await act(async () => {
      first.loads[0]?.resolve(page("Original project", "event-head", "old-cursor", false));
    });
    await act(async () => {
      loadMore()?.dispatchEvent(new dom.window.Event("click", { bubbles: true }));
      loadMore()?.dispatchEvent(new dom.window.Event("click", { bubbles: true }));
    });
    expect(first.loads).toHaveLength(3);

    await act(async () => {
      root.render(createElement(AdapterAwareApp, {
        backendStatus: "connected",
        onRetry: () => undefined,
        projectId: projection.project.id,
        workbenchAdapter: replacement.adapter,
      }));
    });
    expect(replacement.loads).toHaveLength(1);
    await act(async () => {
      replacement.loads[0]?.resolve(page("Replacement project", "event-replacement", null, true));
    });

    await act(async () => {
      first.loads[1]?.resolve(page("Stale old page", "event-stale", null, true));
    });
    await act(async () => {
      first.loads[2]?.reject(new Error("stale old page failure"));
    });
    expect(container.textContent).toContain("Replacement project");
    expect(container.textContent).not.toContain("stale old page failure");
    expect(container.querySelectorAll(".wb-activity-item")).toHaveLength(1);
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

test("fences load-older fulfillment and rejection across a same-project reconnect", async () => {
  const page = (projectName: string, eventId: string, continueCursor: string | null, isDone: boolean) => ({
    ...projection,
    project: { ...projection.project, name: projectName },
    activity: {
      page: [{ id: eventId, kind: "quoteRecorded", createdAt: Date.UTC(2026, 8, 20) }],
      continueCursor,
      isDone,
    },
  });
  interface PendingLoad {
    readonly resolve: (value: unknown) => void;
    readonly reject: (error: unknown) => void;
  }
  const loads: PendingLoad[] = [];
  const adapter = {
    load: (_projectId: string, _cursor?: string | null) => new Promise<unknown>((resolve, reject) => {
      loads.push({ resolve, reject });
    }),
    subscribe: (_projectId: string, _onSnapshot: (snapshot: unknown) => void, _onError: (error: unknown) => void) => () => {},
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
  const loadMore = () => Array.from(container.querySelectorAll("button")).find((button) => button.textContent?.includes("Load older activity"));

  try {
    await act(async () => {
      root.render(createElement(AdapterAwareApp, {
        backendStatus: "connected",
        onRetry: () => undefined,
        projectId: projection.project.id,
        workbenchAdapter: adapter,
      }));
    });
    await act(async () => {
      loads[0]?.resolve(page("Original project", "event-head", "old-cursor", false));
    });
    await act(async () => {
      loadMore()?.dispatchEvent(new dom.window.Event("click", { bubbles: true }));
      loadMore()?.dispatchEvent(new dom.window.Event("click", { bubbles: true }));
    });
    expect(loads).toHaveLength(3);

    await act(async () => {
      root.render(createElement(AdapterAwareApp, {
        backendStatus: "reconnecting",
        onRetry: () => undefined,
        projectId: projection.project.id,
        workbenchAdapter: adapter,
      }));
    });
    await act(async () => {
      root.render(createElement(AdapterAwareApp, {
        backendStatus: "connected",
        onRetry: () => undefined,
        projectId: projection.project.id,
        workbenchAdapter: adapter,
      }));
    });
    expect(loads).toHaveLength(4);
    await act(async () => {
      loads[3]?.resolve(page("Reconnected project", "event-reconnected", null, true));
    });
    await act(async () => {
      loads[1]?.resolve(page("Stale reconnect page", "event-stale-reconnect", null, true));
    });
    await act(async () => {
      loads[2]?.reject(new Error("stale reconnect failure"));
    });
    expect(container.textContent).toContain("Reconnected project");
    expect(container.textContent).not.toContain("stale reconnect failure");
    expect(container.querySelectorAll(".wb-activity-item")).toHaveLength(1);
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

test("parses real E1 asset records with documents, cases, and truncation flags", () => {
  const snapshot = parseWorkbenchSnapshot(projectionWithEquipment({
    assets: [assetFixture()],
    assetsTruncated: true,
  }), projection.project.id);
  if (snapshot === null) throw new Error("E1 equipment projection should parse");
  expect(snapshot.equipment.assets).toHaveLength(1);
  const asset = snapshot.equipment.assets[0]!;
  expect(asset.label).toBe("Atlas 2G espresso machine");
  expect(asset.serial).toBe("ATLAS-0042");
  expect(asset.constraints).toBe("Requires water filtration");
  expect(asset.purchaseProvenance).toBe("Order ord-7, delivered Sep 2026");
  expect(asset.documents).toEqual([{ kind: "warranty", createdAt: Date.UTC(2026, 8, 28) }]);
  expect(asset.documentsTruncated).toBe(false);
  expect(asset.serviceCases[0]?.summary).toBe("Pressure fault on group head");
  expect(asset.serviceCases[0]?.outcome).toBe("Technician visit scheduled");
  expect(snapshot.equipment.assetsTruncated).toBe(true);
  expect(snapshot.truncation.equipment).toBe(true);
});

test("parses assets without optional fields as null without inventing values", () => {
  const snapshot = parseWorkbenchSnapshot(projectionWithEquipment({
    assets: [assetFixture({ serial: undefined, constraints: undefined, purchaseProvenance: undefined, documents: [], serviceCases: [{ id: "case-e1-2", urgency: "low", summary: "Annual descale reminder", state: "open", createdAt: Date.UTC(2026, 9, 1), updatedAt: Date.UTC(2026, 9, 1) }] })],
    assetsTruncated: false,
  }), projection.project.id);
  if (snapshot === null) throw new Error("E1 equipment projection should parse");
  const asset = snapshot.equipment.assets[0]!;
  expect(asset.serial).toBeNull();
  expect(asset.constraints).toBeNull();
  expect(asset.purchaseProvenance).toBeNull();
  expect(asset.documents).toEqual([]);
  expect(asset.serviceCases[0]?.outcome).toBeNull();
});

test("rejects malformed, private, and cross-shape equipment payloads", () => {
  const projectId = projection.project.id;
  expect(parseWorkbenchSnapshot({ ...projection, equipment: undefined }, projectId)).toBeNull();
  expect(parseWorkbenchSnapshot(projectionWithEquipment({ assets: [] }), projectId)).toBeNull();
  expect(parseWorkbenchSnapshot(projectionWithEquipment({ assets: [assetFixture({ label: "" })], assetsTruncated: false }), projectId)).toBeNull();
  expect(parseWorkbenchSnapshot(projectionWithEquipment({ assets: [assetFixture({ serial: 42 })], assetsTruncated: false }), projectId)).toBeNull();
  expect(parseWorkbenchSnapshot(projectionWithEquipment({ assets: [assetFixture({ documents: [{ kind: "warranty", createdAt: Date.UTC(2026, 8, 28), storageRef: "private-bucket/ref" }] })], assetsTruncated: false }), projectId)).toBeNull();
  expect(parseWorkbenchSnapshot(projectionWithEquipment({ assets: [assetFixture({ documents: [{ kind: "warranty", createdAt: Date.UTC(2026, 8, 28), id: "document-e1-1" }] })], assetsTruncated: false }), projectId)).toBeNull();
  const seededCase = (assetFixture().serviceCases as ReadonlyArray<Record<string, unknown>>)[0]!;
  expect(parseWorkbenchSnapshot(projectionWithEquipment({ assets: [assetFixture({ serviceCases: [{ ...seededCase, assetId: "asset-e1-1" }] })], assetsTruncated: false }), projectId)).toBeNull();
  expect(parseWorkbenchSnapshot(projectionWithEquipment({ assets: [assetFixture({ projectId: "project-w1-1" })], assetsTruncated: false }), projectId)).toBeNull();
  expect(parseWorkbenchSnapshot(projectionWithEquipment({ assets: [assetFixture({ label: "Contact private@example.test owner" })], assetsTruncated: false, ownerEmail: "private@example.test" }), projectId)).toBeNull();
  expect(parseWorkbenchSnapshot(projectionWithEquipment({ assets: [assetFixture()], assetsTruncated: "yes" }), projectId)).toBeNull();
});

test("never infers an installed asset from a fulfilled requirement", async () => {
  const snapshot = parseWorkbenchSnapshot({
    ...projection,
    requirements: [{ ...projection.requirements[0], state: "fulfilled", fulfillment: "commissioned" }],
  }, projection.project.id);
  if (snapshot === null) throw new Error("W1 projection should parse");
  expect(snapshot.equipment.assets).toEqual([]);
  const mounted = await mountEquipmentTab({ state: "ready", snapshot }, () => ({ ok: false, message: "controlled test refusal" }));
  try {
    await mounted.clickTab("Equipment");
    expect(mounted.container.textContent).toContain("No installed equipment in this project");
    expect(mounted.container.textContent).toContain("is not an asset until commissioning is recorded");
    expect(mounted.container.textContent).not.toContain("Two-group espresso machine");
  } finally {
    await mounted.cleanup();
  }
});

test("renders real assets with documents, cases, truncation, and opens the service dialog", async () => {
  const snapshot = parseWorkbenchSnapshot(projectionWithEquipment({
    assets: [assetFixture({ documentsTruncated: true, serviceCasesTruncated: true })],
    assetsTruncated: true,
  }), projection.project.id);
  if (snapshot === null) throw new Error("E1 equipment projection should parse");
  const actionCalls: string[] = [];
  const mounted = await mountEquipmentTab({ state: "ready", snapshot }, (action: WorkbenchAction): WorkbenchActionResult => {
    actionCalls.push(action.type);
    return { ok: false, message: "controlled test refusal" };
  });
  try {
    await mounted.clickTab("Equipment");
    const text = mounted.container.textContent ?? "";
    expect(text).toContain("Atlas 2G espresso machine");
    expect(text).toContain("ATLAS-0042");
    expect(text).toContain("Warranty");
    expect(text).toContain("Pressure fault on group head");
    expect(text).toContain("Technician visit scheduled");
    expect(text).toContain("More installed assets exist than this projection shows");
    expect(text).toContain("More documents exist than this projection shows");
    expect(text).toContain("More service cases exist than this projection shows");
    const serviceButton = mounted.findButton("Open service case");
    expect(serviceButton.disabled).toBe(false);
    await act(async () => {
      serviceButton.click();
    });
    expect(mounted.container.querySelector('[role="dialog"]')).not.toBeNull();
    expect(mounted.container.textContent).toContain("What needs attention?");
    expect(mounted.container.textContent).toContain("0/800 characters");
    expect(actionCalls).toEqual([]);
  } finally {
    await mounted.cleanup();
  }
});

test("clicks a projected cancellable queued job and dispatches one cancellation", async () => {
  const snapshot = parseWorkbenchSnapshot(projection, projection.project.id);
  if (snapshot === null) throw new Error("W1 projection should parse");
  const actionCalls: WorkbenchAction[] = [];
  const mounted = await mountEquipmentTab({ state: "ready", snapshot }, (action: WorkbenchAction) => {
    actionCalls.push(action);
    return { ok: true, message: "Cancellation queued by the server." };
  });
  try {
    await mounted.clickTab("Inbox");
    const cancel = mounted.findButton("Cancel");
    expect(cancel.disabled).toBe(false);
    await act(async () => { cancel.click(); });
    expect(actionCalls).toEqual([{ type: "cancelJob", projectId: "project-w1-1", jobId: "job-queued" }]);
  } finally {
    await mounted.cleanup();
  }
});

test("disables generic research and makes zero calls while requirements are truncated", async () => {
  const snapshot = parseWorkbenchSnapshot({ ...projection, requirementsTruncated: true }, projection.project.id);
  if (snapshot === null) throw new Error("Truncated W1 projection should parse");
  const actionCalls: WorkbenchAction[] = [];
  const mounted = await mountEquipmentTab({ state: "ready", snapshot }, (action: WorkbenchAction) => {
    actionCalls.push(action);
    return { ok: true };
  });
  try {
    const start = mounted.findButton("Start bounded research");
    expect(start.disabled).toBe(true);
    await act(async () => { start.click(); });
    expect(actionCalls).toEqual([]);
  } finally {
    await mounted.cleanup();
  }
});

test("keeps concurrent mounted research clicks to one action request", async () => {
  const snapshot = parseWorkbenchSnapshot(projection, projection.project.id);
  if (snapshot === null) throw new Error("W1 projection should parse");
  const actionCalls: WorkbenchAction[] = [];
  let resolveAction: ((result: WorkbenchActionResult) => void) | undefined;
  const actionResult = new Promise<WorkbenchActionResult>((resolve) => { resolveAction = resolve; });
  const mounted = await mountEquipmentTab({ state: "ready", snapshot }, (action: WorkbenchAction) => {
    actionCalls.push(action);
    return actionResult;
  });
  try {
    const start = mounted.findButton("Start bounded research");
    await act(async () => {
      start.click();
      start.click();
    });
    expect(actionCalls).toEqual([{ type: "startResearch", projectId: "project-w1-1" }]);
    resolveAction?.({ ok: true, message: "Research queued by the server." });
    await act(async () => {});
  } finally {
    await mounted.cleanup();
  }
});

test("contains service dialog focus, cycles first and last controls, handles Escape, and restores focus", async () => {
  const snapshot = parseWorkbenchSnapshot(projectionWithEquipment({ assets: [assetFixture()], assetsTruncated: false }), projection.project.id);
  if (snapshot === null) throw new Error("E1 equipment projection should parse");
  const mounted = await mountEquipmentTab({ state: "ready", snapshot }, () => ({ ok: false, message: "controlled test refusal" }));
  try {
    await mounted.clickTab("Equipment");
    const open = mounted.findButton("Open service case");
    open.focus();
    await act(async () => { open.click(); });
    const dialog = mounted.container.querySelector('[role="dialog"]');
    if (!(dialog instanceof Object)) throw new Error("Service dialog not found");
    expect(mounted.container.querySelector(".wb-header")?.hasAttribute("inert")).toBe(true);
    expect(mounted.container.querySelector(".wb-header")?.getAttribute("aria-hidden")).toBe("true");
    const controls = Array.from(dialog.querySelectorAll<HTMLElement>("button:not([disabled]), select:not([disabled]), textarea:not([disabled])"));
    const first = controls[0];
    const last = controls[controls.length - 1];
    if (first === undefined || last === undefined) throw new Error("Service dialog controls not found");
    expect(mounted.container.ownerDocument.activeElement).toBe(first);

    last.focus();
    last.dispatchEvent(new mounted.container.ownerDocument.defaultView!.KeyboardEvent("keydown", { bubbles: true, key: "Tab" }));
    expect(mounted.container.ownerDocument.activeElement).toBe(first);
    first.focus();
    first.dispatchEvent(new mounted.container.ownerDocument.defaultView!.KeyboardEvent("keydown", { bubbles: true, key: "Tab", shiftKey: true }));
    expect(mounted.container.ownerDocument.activeElement).toBe(last);

    const background = mounted.findButton("Project");
    background.focus();
    background.dispatchEvent(new mounted.container.ownerDocument.defaultView!.Event("focusin", { bubbles: true }));
    expect(mounted.container.ownerDocument.activeElement).toBe(first);

    await act(async () => {
      dialog.dispatchEvent(new mounted.container.ownerDocument.defaultView!.KeyboardEvent("keydown", { bubbles: true, key: "Escape" }));
    });
    expect(mounted.container.querySelector('[role="dialog"]')).toBeNull();
    expect(mounted.container.ownerDocument.activeElement).toBe(open);
    expect(mounted.container.querySelector(".wb-header")?.hasAttribute("inert")).toBe(false);
    expect(mounted.container.querySelector(".wb-header")?.hasAttribute("aria-hidden")).toBe(false);
  } finally {
    await mounted.cleanup();
  }
});

test("gives assistant, evidence, and selection dialogs the shared modal keyboard contract", async () => {
  const snapshot = parseWorkbenchSnapshot(projection, projection.project.id);
  if (snapshot === null) throw new Error("W1 projection should parse");
  const mounted = await mountEquipmentTab({ state: "ready", snapshot }, () => ({ ok: false, message: "controlled test refusal" }));
  const document = mounted.container.ownerDocument;
  const keyboardEvent = (key: string, shiftKey = false) => new document.defaultView!.KeyboardEvent("keydown", { bubbles: true, key, shiftKey });
  const modalControls = (dialog: Element): HTMLElement[] => Array.from(dialog.querySelectorAll<HTMLElement>("button:not([disabled]), input:not([disabled]), select:not([disabled]), textarea:not([disabled])"));
  const exerciseModal = async (opener: HTMLButtonElement, disabledButtonLabel?: string): Promise<void> => {
    opener.focus();
    await act(async () => { opener.click(); });
    const dialog = mounted.container.querySelector('[role="dialog"]');
    if (!(dialog instanceof document.defaultView!.HTMLElement)) throw new Error("Modal dialog not found");
    const controls = modalControls(dialog);
    const first = controls[0];
    const last = controls[controls.length - 1];
    if (first === undefined || last === undefined) throw new Error("Modal controls not found");
    expect(document.activeElement).toBe(first);
    expect(mounted.container.querySelector(".wb-header")?.hasAttribute("inert")).toBe(true);
    expect(mounted.container.querySelector(".wb-header")?.getAttribute("aria-hidden")).toBe("true");
    if (disabledButtonLabel !== undefined) {
      const disabledButton = Array.from(dialog.querySelectorAll("button")).find((button) => button.textContent?.includes(disabledButtonLabel));
      if (!(disabledButton instanceof document.defaultView!.HTMLButtonElement)) throw new Error(`${disabledButtonLabel} button not found`);
      expect(disabledButton.disabled).toBe(true);
    }

    last.focus();
    last.dispatchEvent(keyboardEvent("Tab"));
    expect(document.activeElement).toBe(first);
    first.focus();
    first.dispatchEvent(keyboardEvent("Tab", true));
    expect(document.activeElement).toBe(last);

    const background = mounted.findButton("Project");
    background.focus();
    background.dispatchEvent(new document.defaultView!.Event("focusin", { bubbles: true }));
    expect(document.activeElement).toBe(first);

    await act(async () => {
      dialog.dispatchEvent(keyboardEvent("Escape"));
    });
    expect(mounted.container.querySelector('[role="dialog"]')).toBeNull();
    expect(document.activeElement).toBe(opener);
    expect(mounted.container.querySelector(".wb-header")?.hasAttribute("inert")).toBe(false);
    expect(mounted.container.querySelector(".wb-header")?.hasAttribute("aria-hidden")).toBe(false);
  };

  try {
    const assistant = mounted.container.querySelector('button[aria-label="Open project assistant"]');
    if (!(assistant instanceof document.defaultView!.HTMLButtonElement)) throw new Error("Assistant opener not found");
    await exerciseModal(assistant as unknown as HTMLButtonElement);

    await mounted.clickTab("Suppliers");
    const evidence = mounted.container.querySelector('button[aria-label="Open evidence for Harbor Equipment"]');
    if (!(evidence instanceof document.defaultView!.HTMLButtonElement)) throw new Error("Evidence opener not found");
    await exerciseModal(evidence as unknown as HTMLButtonElement);

    await mounted.clickTab("Project");
    const review = mounted.findButton("Review quote");
    await exerciseModal(review, "Select exact quote");
  } finally {
    await mounted.cleanup();
  }
});

test("keeps the equipment service action disabled with zero adapter calls while reconnecting", async () => {
  const snapshot = parseWorkbenchSnapshot(projectionWithEquipment({
    assets: [assetFixture()],
    assetsTruncated: false,
  }), projection.project.id);
  if (snapshot === null) throw new Error("E1 equipment projection should parse");
  const actionCalls: string[] = [];
  const mounted = await mountEquipmentTab({ state: "reconnecting", lastKnown: snapshot }, (action: WorkbenchAction): WorkbenchActionResult => {
    actionCalls.push(action.type);
    return { ok: false, message: "controlled test refusal" };
  });
  try {
    await mounted.clickTab("Equipment");
    expect(mounted.container.textContent).toContain("Atlas 2G espresso machine");
    expect(mounted.findButton("Open service case").disabled).toBe(true);
    expect(actionCalls).toEqual([]);
  } finally {
    await mounted.cleanup();
  }
});

test("enables a pending approval from its safe basis without requiring an evidence array", async () => {
  const snapshot = parseWorkbenchSnapshot(projection, projection.project.id);
  if (snapshot === null) throw new Error("W1 projection should parse");
  const actionCalls: WorkbenchAction[] = [];
  const mounted = await mountEquipmentTab({ state: "ready", snapshot }, (action: WorkbenchAction) => {
    actionCalls.push(action);
    return { ok: true, message: "approval recorded by server" };
  });
  try {
    await mounted.clickTab("Inbox");
    const approve = mounted.findButton("Approve this decision");
    expect(approve.disabled).toBe(false);
    expect(mounted.container.textContent).toContain("Immutable decision basis");
    expect(mounted.container.textContent).toContain("snapshot-hash-w1-1");
    await act(async () => { approve.click(); });
    expect(actionCalls).toEqual([{ type: "approveDecision", projectId: "project-w1-1", decisionId: "approval-w1-1" }]);
  } finally {
    await mounted.cleanup();
  }
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
    jobs: parsed.jobs.map((job, index) => index === 0 ? { ...job, state: "queued" as const } : job),
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

// -- U1 narrow-viewport and nested-dialog visual recovery --------------------

test("keeps the narrow workbench heading fluid and wrappable", async () => {
  const css = await Bun.file(new URL("../styles.css", import.meta.url)).text();
  const narrowBlock = css.slice(css.indexOf("@media (max-width: 480px)"));
  expect(narrowBlock).toContain(".wb-page-heading h1");
  const narrowHeading = narrowBlock.match(/\.wb-page-heading h1\s*\{[^}]*\}/);
  expect(narrowHeading?.[0]).toContain("clamp(");
  expect(narrowHeading?.[0]).toContain("overflow-wrap");
  expect(narrowHeading?.[0]).not.toMatch(/font-size:\s*\d+(\.\d+)?rem\s*;/);
  const baseHeading = css.match(/\.wb-page-heading h1\s*\{[^}]*\}/);
  expect(baseHeading?.[0]).toContain("overflow-wrap");
});

test("makes all background content inert for the nested service dialog and restores exactly", async () => {
  const snapshot = parseWorkbenchSnapshot(projectionWithEquipment({
    assets: [assetFixture()],
    assetsTruncated: false,
  }), projection.project.id);
  if (snapshot === null) throw new Error("E1 equipment projection should parse");
  const mounted = await mountEquipmentTab({ state: "ready", snapshot }, () => ({ ok: false, message: "controlled test refusal" }));
  try {
    await mounted.clickTab("Equipment");
    // A pre-existing background state the dialog must preserve exactly.
    const overview = mounted.container.querySelector(".wb-overview-strip");
    if (!(overview instanceof mounted.container.ownerDocument.defaultView!.HTMLElement)) throw new Error("Overview strip not found");
    overview.setAttribute("inert", "");
    overview.setAttribute("aria-hidden", "false");
    const open = mounted.findButton("Open service case");
    open.focus();
    await act(async () => { open.click(); });
    const dialog = mounted.container.querySelector('.wb-service-case-panel[role="dialog"]');
    if (!(dialog instanceof mounted.container.ownerDocument.defaultView!.HTMLElement)) throw new Error("Service dialog not found");
    const header = mounted.container.querySelector(".wb-header");
    const banner = mounted.container.querySelector(".wb-demo-banner");
    expect(header?.hasAttribute("inert")).toBe(true);
    expect(header?.getAttribute("aria-hidden")).toBe("true");
    expect(banner?.hasAttribute("inert")).toBe(true);
    expect(banner?.getAttribute("aria-hidden")).toBe("true");
    // The nested dialog observes the pre-existing state instead of overwriting it.
    expect(overview.hasAttribute("inert")).toBe(true);
    expect(overview.getAttribute("aria-hidden")).toBe("true");
    // The dialog ancestor chain stays interactive and the dialog stays exposed.
    expect(mounted.container.querySelector("#workbench-main")?.hasAttribute("inert")).toBe(false);
    expect(dialog.getAttribute("aria-hidden")).toBeNull();
    expect(dialog.contains(mounted.container.ownerDocument.activeElement)).toBe(true);

    await act(async () => {
      dialog.dispatchEvent(new mounted.container.ownerDocument.defaultView!.KeyboardEvent("keydown", { bubbles: true, key: "Escape" }));
    });
    expect(mounted.container.querySelector('[role="dialog"]')).toBeNull();
    expect(header?.hasAttribute("inert")).toBe(false);
    expect(header?.hasAttribute("aria-hidden")).toBe(false);
    expect(banner?.hasAttribute("inert")).toBe(false);
    // The pre-existing inert state restores exactly, including its odd value.
    expect(overview.hasAttribute("inert")).toBe(true);
    expect(overview.getAttribute("aria-hidden")).toBe("false");
    expect(mounted.container.ownerDocument.activeElement).toBe(open);
  } finally {
    await mounted.cleanup();
  }
});

function e8ImpactFixture(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    id: "assessment-e8-1",
    requirementId: "requirement-w1-1",
    trigger: "quoteRevision",
    state: "recorded",
    orderImpact: "reviewRequired",
    reason: "Quote v1 was superseded by v2; 1 placed order(s) keep their history and need fresh approval before any substitute",
    quoteVersion: "v2",
    predecessorQuoteVersion: "v1",
    placedOrderCount: 1,
    createdAt: Date.UTC(2026, 8, 21),
    ...overrides,
  };
}

function e8SubstituteFixture(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    id: "proposal-e8-1",
    requirementId: "requirement-w1-1",
    assessmentId: "assessment-e8-1",
    proposedCandidateId: "candidate-w1-1",
    proposedQuoteId: "quote-w1-1",
    proposedQuoteVersion: "2",
    state: "pending",
    reason: "Selected revision was superseded; Harbor Equipment keeps current terms",
    basisStale: false,
    basisReason: "Proposed quote revision and requirement version are still current.",
    createdAt: Date.UTC(2026, 8, 22),
    updatedAt: Date.UTC(2026, 8, 22),
    ...overrides,
  };
}

function e8Projection(extra: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    ...(projection as unknown as Record<string, unknown>),
    impacts: [e8ImpactFixture()],
    impactsTruncated: false,
    substitutes: [e8SubstituteFixture()],
    substitutesTruncated: false,
    ...extra,
  };
}

async function mountE8Tab(
  loadState: Parameters<typeof WorkbenchView>[0]["loadState"],
  onAction: (action: WorkbenchAction) => WorkbenchActionResult | Promise<WorkbenchActionResult>,
): Promise<{
  readonly container: HTMLElement;
  readonly findButton: (label: string) => HTMLButtonElement;
  readonly clickTab: (label: string) => Promise<void>;
  readonly cleanup: () => Promise<void>;
}> {
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
  const happyElement = dom.document.createElement("div");
  dom.document.body.append(happyElement);
  const container = happyElement as unknown as HTMLElement;
  const root = createRoot(container as unknown as globalThis.Element);
  await act(async () => {
    root.render(createElement(WorkbenchView, { loadState, onAction }));
  });
  const findButton = (label: string): HTMLButtonElement => {
    const button = Array.from(container.querySelectorAll("button")).find((candidate) => candidate.textContent?.includes(label));
    if (!(button instanceof dom.window.HTMLButtonElement)) throw new Error(`Button not found: ${label}`);
    return button as unknown as HTMLButtonElement;
  };
  return {
    container,
    findButton,
    clickTab: async (label: string) => {
      await act(async () => {
        findButton(label).click();
      });
    },
    cleanup: async () => {
      await act(async () => {
        root.unmount();
      });
      browserGlobals.window = previousWindow;
      browserGlobals.document = previousDocument;
      browserGlobals.navigator = previousNavigator;
      if (previousActEnvironment === undefined) delete actEnvironment.IS_REACT_ACT_ENVIRONMENT;
      else actEnvironment.IS_REACT_ACT_ENVIRONMENT = previousActEnvironment;
    },
  };
}

test("parses stored E8 impacts and substitutes with stale/current basis", () => {
  const snapshot = parseWorkbenchSnapshot(e8Projection(), projection.project.id);
  if (snapshot === null) throw new Error("E8 projection should parse");
  expect(snapshot.impacts).toHaveLength(1);
  expect(snapshot.impacts[0]?.orderImpact).toBe("reviewRequired");
  expect(snapshot.impacts[0]?.reason).toContain("keep their history");
  expect(snapshot.substitutes[0]?.state).toBe("pending");
  expect(snapshot.substitutes[0]?.basisStale).toBe(false);
  expect(snapshot.truncation.impacts).toBe(false);
  expect(snapshot.truncation.substitutes).toBe(false);
  expect(parseWorkbenchSnapshot(e8Projection({ impacts: [{ ...e8ImpactFixture(), orderImpact: "delayed" }] }), projection.project.id)).toBeNull();
  expect(parseWorkbenchSnapshot(e8Projection({ substitutes: [{ ...e8SubstituteFixture(), basisStale: "no" }] }), projection.project.id)).toBeNull();
});

test("renders due decisions with reason, basis, and truncation in the inbox", async () => {
  const snapshot = parseWorkbenchSnapshot(e8Projection({ impactsTruncated: true, substitutesTruncated: true }), projection.project.id);
  if (snapshot === null) throw new Error("E8 projection should parse");
  const mounted = await mountE8Tab({ state: "ready", snapshot }, () => ({ ok: false, message: "controlled test refusal" }));
  try {
    await mounted.clickTab("Inbox");
    expect(mounted.container.textContent).toContain("Due decisions with their reason and basis.");
    expect(mounted.container.textContent).toContain("keep their history");
    expect(mounted.container.textContent).toContain("keeps current terms");
    expect(mounted.container.textContent).toContain("still current");
    expect(mounted.container.textContent).toContain("More changed-term assessments exist");
    expect(mounted.container.textContent).toContain("More substitute proposals exist");
    expect(mounted.findButton("Approve substitute").disabled).toBe(false);
  } finally {
    await mounted.cleanup();
  }
});

test("stale substitute approval stays disabled with zero writes while rejection still routes", async () => {
  const snapshot = parseWorkbenchSnapshot(e8Projection({
    substitutes: [e8SubstituteFixture({ basisStale: true, basisReason: "Proposed quote terms changed; renewed authority required." })],
  }), projection.project.id);
  if (snapshot === null) throw new Error("E8 projection should parse");
  const actionCalls: string[] = [];
  const mounted = await mountE8Tab({ state: "ready", snapshot }, (action: WorkbenchAction): WorkbenchActionResult => {
    actionCalls.push(action.type);
    return { ok: false, message: "controlled test refusal" };
  });
  try {
    await mounted.clickTab("Inbox");
    expect(mounted.container.textContent).toContain("Stale basis");
    expect(mounted.container.textContent).toContain("Proposed quote terms changed");
    expect(mounted.findButton("Approve substitute").disabled).toBe(true);
    expect(mounted.findButton("Reject").disabled).toBe(false);
    await act(async () => {
      mounted.findButton("Approve substitute").click();
    });
    expect(actionCalls).toEqual([]);
    await act(async () => {
      mounted.findButton("Reject").click();
    });
    expect(actionCalls).toEqual(["decideSubstituteProposal"]);
  } finally {
    await mounted.cleanup();
  }
});

test("approved substitute calls the authorized impact route and reports server text", async () => {
  const snapshot = parseWorkbenchSnapshot(e8Projection(), projection.project.id);
  if (snapshot === null) throw new Error("E8 projection should parse");
  const actionCalls: WorkbenchAction[] = [];
  const mounted = await mountE8Tab({ state: "ready", snapshot }, (action: WorkbenchAction): WorkbenchActionResult => {
    actionCalls.push(action);
    return { ok: true, message: "Substitute approved by the server; execute it as an explicit new selection." };
  });
  try {
    await mounted.clickTab("Inbox");
    await act(async () => {
      mounted.findButton("Approve substitute").click();
    });
    expect(actionCalls).toEqual([{ type: "decideSubstituteProposal", projectId: projection.project.id, proposalId: "proposal-e8-1", decision: "approved" }]);
    expect(mounted.container.textContent).toContain("Substitute approved by the server");
  } finally {
    await mounted.cleanup();
  }
});

test("recovery lists changed-term impacts and pending substitutes with honest states", async () => {
  const snapshot = parseWorkbenchSnapshot(e8Projection({
    impacts: [e8ImpactFixture({ state: "unknown", orderImpact: "unknown", reason: "Watch check reported error; availability stays unknown and placed orders are unchanged" })],
  }), projection.project.id);
  if (snapshot === null) throw new Error("E8 projection should parse");
  const mounted = await mountE8Tab({ state: "ready", snapshot }, () => ({ ok: false, message: "controlled test refusal" }));
  try {
    await mounted.clickTab("Recovery");
    expect(mounted.container.textContent).toContain("availability stays unknown");
    expect(mounted.container.textContent).toContain("placed orders are unchanged");
    expect(mounted.container.textContent).toContain("keeps current terms");
    expect(mounted.container.textContent).not.toContain("No recovery is waiting");
  } finally {
    await mounted.cleanup();
  }
});

test("project tab banners due changed terms without claiming an order", async () => {
  const snapshot = parseWorkbenchSnapshot(e8Projection(), projection.project.id);
  if (snapshot === null) throw new Error("E8 projection should parse");
  const mounted = await mountE8Tab({ state: "ready", snapshot }, () => ({ ok: false, message: "controlled test refusal" }));
  try {
    expect(mounted.container.textContent).toContain("Changed terms need review");
    expect(mounted.container.textContent).toContain("No order was placed");
  } finally {
    await mounted.cleanup();
  }
});

test("E8 cards reuse fluid panel layout with no fixed-width overflow", async () => {
  const css = await Bun.file(new URL("../styles.css", import.meta.url)).text();
  expect(css).not.toContain(".wb-impact-card {");
  expect(css).not.toContain(".wb-substitute-card {");
  expect(css).toContain("@media (max-width: 480px)");
  const snapshot = parseWorkbenchSnapshot(e8Projection(), projection.project.id);
  if (snapshot === null) throw new Error("E8 projection should parse");
  const mounted = await mountE8Tab({ state: "ready", snapshot }, () => ({ ok: false, message: "controlled test refusal" }));
  try {
    await mounted.clickTab("Inbox");
    expect(mounted.container.innerHTML).toContain("wb-impact-card");
    expect(mounted.container.innerHTML).toContain("wb-substitute-card");
  } finally {
    await mounted.cleanup();
  }
});

test("inbox never claims nothing needs review while E8 due items exist", async () => {
  const snapshot = parseWorkbenchSnapshot(e8Projection({ decisions: [], jobs: [] }), projection.project.id);
  if (snapshot === null) throw new Error("E8 projection should parse");
  expect(snapshot.decisions).toEqual([]);
  expect(snapshot.jobs).toEqual([]);
  const mounted = await mountE8Tab({ state: "ready", snapshot }, () => ({ ok: false, message: "controlled test refusal" }));
  try {
    await mounted.clickTab("Inbox");
    expect(mounted.container.textContent).not.toContain("Nothing needs your review");
    expect(mounted.container.textContent).toContain("Due decisions with their reason and basis.");
    expect(mounted.container.textContent).toContain("keeps current terms");
  } finally {
    await mounted.cleanup();
  }
  const empty = parseWorkbenchSnapshot(e8Projection({ decisions: [], jobs: [], impacts: [], substitutes: [] }), projection.project.id);
  if (empty === null) throw new Error("Empty E8 projection should parse");
  const mountedEmpty = await mountE8Tab({ state: "ready", snapshot: empty }, () => ({ ok: false, message: "controlled test refusal" }));
  try {
    await mountedEmpty.clickTab("Inbox");
    expect(mountedEmpty.container.textContent).toContain("Nothing needs your review");
  } finally {
    await mountedEmpty.cleanup();
  }
});

// -- E8 prototype-fidelity desk composition (real projection data only) ------

function candidateWithCompleteQuote(overrides: Record<string, unknown>): Record<string, unknown> {
  const base = (projection as unknown as Record<string, unknown>).candidates as readonly Record<string, unknown>[];
  const template = base[0]!;
  return { ...template, compatibility: "pass", ...overrides };
}

function completeQuote(totalMinorUnits: number): Record<string, unknown> {
  return {
    id: `quote-complete-${totalMinorUnits}`,
    version: "2",
    currency: "EUR",
    lines: [{ lineId: "machine", description: "Atlas 2G", quantity: "1", unitPrice: { currency: "EUR", minorUnits: totalMinorUnits - 100000 } }],
    charges: [
      { chargeId: "charge-freight", label: "freight", scope: { kind: "quote" }, state: { kind: "known", amount: { currency: "EUR", minorUnits: 60000 } } },
      { chargeId: "charge-installation", label: "installation", scope: { kind: "quote" }, state: { kind: "known", amount: { currency: "EUR", minorUnits: 40000 } } },
      { chargeId: "charge-machine", label: "machine", scope: { kind: "line", lineId: "machine" }, state: { kind: "known", amount: { currency: "EUR", minorUnits: totalMinorUnits - 100000 } } },
    ],
    taxBasis: { kind: "inclusive", basisId: "tax-w1-1" },
    createdAt: Date.UTC(2026, 8, 20),
    provenance: { mode: "recorded", label: "Recorded owner exchange", ownerAuthoredTerms: true },
    currentness: "current",
    superseded: false,
    totalMinorUnits,
    comparableTotalMinorUnits: totalMinorUnits,
  };
}

function twoOfferProjection(): Record<string, unknown> {
  const base = projection as unknown as Record<string, unknown>;
  const template = (base.candidates as readonly Record<string, unknown>[])[0]!;
  const firstQuote = template.latestValidQuote as Record<string, unknown>;
  return {
    ...base,
    candidates: [
      candidateWithCompleteQuote({
        id: "candidate-w1-1",
        vendor: { id: "vendor-w1-1", name: "Harbor Equipment", regions: ["NL"], serviceCoverage: "Service coverage reported for this inquiry" },
        latestValidQuote: { ...firstQuote, ...completeQuote(850000), id: "quote-w1-complete" },
      }),
      candidateWithCompleteQuote({
        id: "candidate-w1-2",
        vendor: { id: "vendor-w1-2", name: "Elm Supply", regions: ["NL"], serviceCoverage: "Service coverage reported for this inquiry" },
        latestValidQuote: { ...firstQuote, ...completeQuote(795000), id: "quote-w1-2-complete" },
      }),
    ],
  };
}

test("renders the decision desk from real requirement and offer records", async () => {
  const snapshot = parseWorkbenchSnapshot(projection, projection.project.id);
  if (snapshot === null) throw new Error("W1 projection should parse");
  const mounted = await mountE8Tab({ state: "ready", snapshot }, () => ({ ok: false, message: "controlled test refusal" }));
  try {
    expect(mounted.container.textContent).toContain("Two-group espresso machine");
    expect(mounted.container.textContent).toContain("ON YOUR LIST");
    expect(mounted.container.textContent).toContain("Need by");
    expect(mounted.container.textContent).toContain("Allocation");
    expect(mounted.container.textContent).toContain("Harbor Equipment");
    expect(mounted.container.textContent).toContain("Missing terms");
    expect(mounted.container.textContent).toContain("Validity not confirmed");
    expect(mounted.container.textContent).toContain("Review selected offer");
    expect(mounted.container.textContent).toContain("Ask about these quotes");
    expect(mounted.container.textContent).toContain("No order is placed.");
    expect(mounted.container.textContent).toContain("All 1 suppliers");
    expect(mounted.container.querySelector(".wb-comparison-tape")).toBeNull();
  } finally {
    await mounted.cleanup();
  }
});

test("shows an honest comparable-total difference only for complete papers", async () => {
  const snapshot = parseWorkbenchSnapshot(twoOfferProjection(), projection.project.id);
  if (snapshot === null) throw new Error("Two-offer projection should parse");
  const mounted = await mountE8Tab({ state: "ready", snapshot }, () => ({ ok: false, message: "controlled test refusal" }));
  try {
    const tape = mounted.container.querySelector(".wb-comparison-tape");
    if (tape === null) throw new Error("Comparison tape should render for two complete offers");
    expect(tape.textContent).toContain("Elm Supply");
    expect(tape.textContent).toContain("Harbor Equipment");
    expect(tape.textContent).toContain("apart in comparable totals");
    expect(tape.textContent).not.toContain("saving");
  } finally {
    await mounted.cleanup();
  }
});

test("bench actions open the real review dialog and assistant rail", async () => {
  const snapshot = parseWorkbenchSnapshot(twoOfferProjection(), projection.project.id);
  if (snapshot === null) throw new Error("Two-offer projection should parse");
  const mounted = await mountE8Tab({ state: "ready", snapshot }, () => ({ ok: true, message: "controlled selection route" }));
  try {
    expect(mounted.findButton("Review selected offer").disabled).toBe(false);
    await act(async () => {
      mounted.findButton("Review selected offer").click();
    });
    expect(mounted.container.textContent).toContain("DECISION REVIEW");
    expect(mounted.container.textContent).toContain("Selection is not an order.");
    const dialog = mounted.container.querySelector('.wb-selection-panel[role="dialog"]');
    if (!(dialog instanceof mounted.container.ownerDocument.defaultView!.HTMLElement)) throw new Error("Selection dialog not found");
    await act(async () => {
      dialog.dispatchEvent(new mounted.container.ownerDocument.defaultView!.KeyboardEvent("keydown", { bubbles: true, key: "Escape" }));
    });
    expect(mounted.container.querySelector('[role="dialog"]')).toBeNull();
    await act(async () => {
      mounted.findButton("Ask about these quotes").click();
    });
    expect(mounted.container.textContent).toContain("Ask about this decision.");
  } finally {
    await mounted.cleanup();
  }
});
