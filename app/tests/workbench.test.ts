import { expect, test } from "bun:test";
import { Window as HappyWindow } from "happy-dom";
import { createElement } from "react";
import { act } from "react";
import { createRoot } from "react-dom/client";
import { renderToStaticMarkup } from "react-dom/server";
import App from "../App";
import WorkbenchView from "../Workbench";
import { AdapterAwareApp, appendWorkbenchActivity } from "../main";
import { formatMoney, hasCurrentReviewableQuote, parseWorkbenchSnapshot, type WorkbenchAction, type WorkbenchActionResult } from "../workbench-state";

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
  expect(html).toContain("NO AUTHORIZED PROJECT");
  expect(html).toContain("No authorized project projection is available yet.");
  expect(html).toContain("No vendors, quotes or provider outcomes are shown");
  expect(html).toContain("Less chasing.");
  expect(html).toContain("Try the Northside");
  expect(html).toContain("Start your own brief");
  expect(html).toContain("wb-landing-status");
  expect(html).not.toContain("wb-connected-empty");
  expect(html).not.toContain("Harbor Equipment");
  expect(html).not.toContain("OpeningOS is ready to connect");
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
      findButton("Review selected result").click();
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
    // An incomplete live source stays inspectable but never reviewable: the
    // quote-review buttons are disabled with zero writes, while the
    // source-record action (owner mailbox exchange behind these terms)
    // remains available.
    const reviewUnavailable = incompleteQuote.findButton("Review unavailable");
    expect(reviewUnavailable.disabled).toBe(true);
    expect(reviewUnavailable.title).toContain("exact total");
    const cta = incompleteQuote.findButton("Review selected result");
    expect(cta.disabled).toBe(true);
    expect(cta.title).toContain("exact total");
    expect(incompleteQuote.container.querySelector('[role="dialog"]')).toBeNull();
    expect(incompleteQuote.actionCalls).toEqual([]);
    expect(incompleteQuote.container.textContent).toContain("Original quote document");
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
  const snapshot = parseWorkbenchSnapshot(twoOfferProjection(), projection.project.id);
  if (snapshot === null) throw new Error("Two-offer projection should parse");
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

    await mounted.clickTab("Results");
    const evidence = mounted.container.querySelector('button[aria-label="Inspect source for Harbor Equipment"]');
    if (!(evidence instanceof document.defaultView!.HTMLButtonElement)) throw new Error("Evidence opener not found");
    await exerciseModal(evidence as unknown as HTMLButtonElement);

    await mounted.clickTab("Project");
    const review = mounted.findButton("Review quote");
    // The two-offer fixture carries current compatible quotes with an exact
    // basis, so review opens with selection enabled; the modal contract is
    // what this exercises.
    await exerciseModal(review);
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
    // Quote review never opens from an incomplete source: the review control
    // is disabled, no dialog appears, and zero actions are dispatched.
    const reviewUnavailable = findButton("Review unavailable");
    expect(reviewUnavailable.disabled).toBe(true);
    await act(async () => {
      reviewUnavailable.click();
    });
    expect(container.querySelector('[role="dialog"]')).toBeNull();
    expect(actionCalls).toEqual([]);
    await clickTab("Inbox");
    expect(findButton("Approve this decision").disabled).toBe(true);
    const inboxButtons = Array.from(container.querySelectorAll("button")).map((button) => button.textContent ?? "");
    expect(inboxButtons.some((text) => text.includes("Retry bounded branch"))).toBe(false);
    expect(container.textContent).toContain("reservation is retained");
    expect(findButton("Cancel").disabled).toBe(true);
    await clickTab("Recovery");
    const recoveryButtons = Array.from(container.querySelectorAll("button")).map((button) => button.textContent ?? "");
    expect(recoveryButtons.some((text) => text.includes("Retry bounded branch"))).toBe(false);
    expect(container.textContent).toContain("Retained in this projection:");
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

function completeQuote(totalMinorUnits: number, currency = "EUR"): Record<string, unknown> {
  return {
    id: `quote-complete-${totalMinorUnits}`,
    version: "2",
    currency,
    lines: [{ lineId: "machine", description: "Atlas 2G", quantity: "1", unitPrice: { currency, minorUnits: totalMinorUnits - 100000 } }],
    charges: [
      { chargeId: "charge-freight", label: "freight", scope: { kind: "quote" }, state: { kind: "known", amount: { currency, minorUnits: 60000 } } },
      { chargeId: "charge-installation", label: "installation", scope: { kind: "quote" }, state: { kind: "known", amount: { currency, minorUnits: 40000 } } },
      { chargeId: "charge-machine", label: "machine", scope: { kind: "line", lineId: "machine" }, state: { kind: "known", amount: { currency, minorUnits: totalMinorUnits - 100000 } } },
    ],
    taxBasis: { kind: "inclusive", basisId: "tax-w1-1" },
    createdAt: Date.UTC(2026, 8, 20),
    provenance: { mode: "recorded", label: "Recorded owner exchange", ownerAuthoredTerms: true },
    currentness: "current",
    superseded: false,
    totalMinorUnits,
    comparableTotalMinorUnits: totalMinorUnits,
    total: { currency, minorUnits: totalMinorUnits },
    comparisonScope: {
      requirementId: "requirement-w1-1",
      scopeId: "scope-w1-espresso",
      items: [{ itemId: "item-w1-machine", lineId: "machine", unit: "unit", requiredQuantity: "1" }],
    },
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
        comparisons: [{ againstCandidateId: "candidate-w1-2", againstQuoteId: "quote-w1-2-complete", status: "comparable", reason: "equivalent-scope", differenceMinorUnits: 54951, cheaper: "other", estimatedDeltaMinorUnits: null }],
      }),
      candidateWithCompleteQuote({
        id: "candidate-w1-2",
        vendor: { id: "vendor-w1-2", name: "Elm Supply", regions: ["NL"], serviceCoverage: "Service coverage reported for this inquiry" },
        latestValidQuote: { ...firstQuote, ...completeQuote(795049), id: "quote-w1-2-complete" },
        comparisons: [{ againstCandidateId: "candidate-w1-1", againstQuoteId: "quote-w1-complete", status: "comparable", reason: "equivalent-scope", differenceMinorUnits: 54951, cheaper: "self", estimatedDeltaMinorUnits: null }],
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
    expect(mounted.container.textContent).toContain("Review selected result");
    expect(mounted.container.textContent).toContain("Ask about these results");
    expect(mounted.container.textContent).toContain("No order is placed.");
    expect(mounted.container.textContent).toContain("All 1 results");
    expect(mounted.container.querySelector(".wb-comparison-tape")).toBeNull();
  } finally {
    await mounted.cleanup();
  }
});

test("shows the exact backend 549.51 EUR delta without recomputing a rank", async () => {
  const snapshot = parseWorkbenchSnapshot(twoOfferProjection(), projection.project.id);
  if (snapshot === null) throw new Error("Two-offer projection should parse");
  const mounted = await mountE8Tab({ state: "ready", snapshot }, () => ({ ok: false, message: "controlled test refusal" }));
  try {
    const tape = mounted.container.querySelector(".wb-comparison-tape");
    if (tape === null) throw new Error("Comparison tape should render for two complete offers");
    expect(tape.textContent).toContain("Elm Supply");
    expect(tape.textContent).toContain("Harbor Equipment");
    expect(tape.textContent).toContain("549.51");
    expect(tape.textContent).toContain("lower than");
    expect(tape.textContent).toContain("accepted comparison scope");
    expect(tape.textContent).not.toContain("saving");
  } finally {
    await mounted.cleanup();
  }
});

function projectionWithPairStatus(
  status: "estimated" | "incompatible" | "incomplete",
  reason: string,
): Record<string, unknown> {
  const value = twoOfferProjection();
  const candidates = value.candidates as readonly Record<string, unknown>[];
  return {
    ...value,
    candidates: candidates.map((candidate, index) => ({
      ...candidate,
      comparisons: [{
        againstCandidateId: index === 0 ? "candidate-w1-2" : "candidate-w1-1",
        againstQuoteId: index === 0 ? "quote-w1-2-complete" : "quote-w1-complete",
        status,
        reason,
        differenceMinorUnits: null,
        cheaper: null,
        estimatedDeltaMinorUnits: status === "estimated" ? { minimum: -60000, maximum: -50000 } : null,
      }],
    })),
  };
}

test("mixed native currencies stay visible without a frontend rank", async () => {
  const value = projectionWithPairStatus("incompatible", "mixed-currency-requires-accepted-conversion-basis");
  const candidates = value.candidates as readonly Record<string, unknown>[];
  const first = candidates[0];
  const second = candidates[1];
  if (first === undefined || second === undefined) throw new Error("Both offers are required");
  value.candidates = [
    first,
    { ...second, latestValidQuote: { ...completeQuote(795049, "USD"), id: "quote-w1-2-complete" } },
  ];
  const snapshot = parseWorkbenchSnapshot(value, projection.project.id);
  if (snapshot === null) throw new Error("Mixed-currency projection should parse");
  const mounted = await mountE8Tab({ state: "ready", snapshot }, () => ({ ok: false, message: "controlled test refusal" }));
  try {
    const tape = mounted.container.querySelector(".wb-comparison-tape.not-ranked");
    if (tape === null) throw new Error("Non-ranking comparison tape should render");
    expect(tape.textContent).toContain("Not comparable");
    expect(tape.textContent).toContain("No offer is ranked");
    expect(tape.textContent).not.toContain("lower than");
    await mounted.clickTab("Results");
    const prices = [...mounted.container.querySelectorAll(".wb-supplier-price strong")].map((node) => node.textContent ?? "");
    expect(prices.some((price) => price.includes("€"))).toBe(true);
    expect(prices.some((price) => price.includes("$"))).toBe(true);
  } finally {
    await mounted.cleanup();
  }
});

test("tax and scope incompatibility reasons remain non-ranking", async () => {
  for (const reason of ["tax bases are not compatible", "comparison scopes are not compatible"]) {
    const snapshot = parseWorkbenchSnapshot(projectionWithPairStatus("incompatible", reason), projection.project.id);
    if (snapshot === null) throw new Error("Incompatible projection should parse");
    const mounted = await mountE8Tab({ state: "ready", snapshot }, () => ({ ok: false, message: "controlled test refusal" }));
    try {
      const tape = mounted.container.querySelector(".wb-comparison-tape.not-ranked");
      expect(tape?.textContent).toContain(reason);
      expect(tape?.textContent).toContain("No offer is ranked");
    } finally {
      await mounted.cleanup();
    }
  }
});

test("an incomplete pair stays visible with no exact difference", async () => {
  const snapshot = parseWorkbenchSnapshot(projectionWithPairStatus("incomplete", "Freight is unknown"), projection.project.id);
  if (snapshot === null) throw new Error("Incomplete projection should parse");
  const mounted = await mountE8Tab({ state: "ready", snapshot }, () => ({ ok: false, message: "controlled test refusal" }));
  try {
    const tape = mounted.container.querySelector(".wb-comparison-tape.not-ranked");
    expect(tape?.textContent).toContain("Comparison incomplete");
    expect(tape?.textContent).toContain("Freight is unknown");
    expect(tape?.textContent).not.toContain("549.51");
  } finally {
    await mounted.cleanup();
  }
});

test("bench actions open the real review dialog and assistant rail", async () => {
  const snapshot = parseWorkbenchSnapshot(twoOfferProjection(), projection.project.id);
  if (snapshot === null) throw new Error("Two-offer projection should parse");
  const mounted = await mountE8Tab({ state: "ready", snapshot }, () => ({ ok: true, message: "controlled selection route" }));
  try {
    expect(mounted.findButton("Review selected result").disabled).toBe(false);
    await act(async () => {
      mounted.findButton("Review selected result").click();
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
      mounted.findButton("Ask about these results").click();
    });
    expect(mounted.container.textContent).toContain("Ask about this decision.");
  } finally {
    await mounted.cleanup();
  }
});

// -- F4 projected evidence source -------------------------------------------

async function mountProjectView(
  loadState: Parameters<typeof WorkbenchView>[0]["loadState"],
): Promise<{
  readonly container: HTMLElement;
  readonly dom: HappyWindow;
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
    root.render(createElement(WorkbenchView, { loadState }));
  });
  return {
    container,
    dom,
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

function projectionWithEvidenceSource(sourceUrl: string | undefined): Record<string, unknown> {
  const base = projection as unknown as Record<string, unknown>;
  const candidates = base.candidates as readonly Record<string, unknown>[];
  const candidate = candidates[0]!;
  const evidence = candidate.evidence as readonly Record<string, unknown>[];
  return {
    ...base,
    candidates: [{
      ...candidate,
      evidence: [{ ...evidence[0]!, ...(sourceUrl === undefined ? {} : { sourceUrl }) }],
    }],
  };
}

test("view original opens the validated projected source URL without private material", async () => {
  const snapshot = parseWorkbenchSnapshot(projectionWithEvidenceSource("https://supplier.example.test/quote.pdf"), projection.project.id);
  if (snapshot === null) throw new Error("Evidence projection should parse");
  const mounted = await mountProjectView({ state: "ready", snapshot });
  try {
    const opener = mounted.container.querySelector(".wb-paper-source");
    if (!(opener instanceof mounted.dom.window.HTMLButtonElement)) throw new Error("View original button not found");
    await act(async () => {
      (opener as unknown as HTMLButtonElement).click();
    });
    const dialog = mounted.container.querySelector('.wb-evidence-panel[role="dialog"]');
    expect(dialog).not.toBeNull();
    const link = mounted.container.querySelector('.wb-evidence-panel a[href="https://supplier.example.test/quote.pdf"]');
    if (!(link instanceof mounted.dom.window.HTMLAnchorElement)) throw new Error("Projected source link not found");
    expect((link as unknown as HTMLAnchorElement).target).toBe("_blank");
    expect(mounted.container.textContent).toContain("PRIVATE HEADERS REDACTED");
    expect(mounted.container.textContent).not.toContain("providerId");
    expect(mounted.container.textContent).not.toContain("rawHeaders");
  } finally {
    await mounted.cleanup();
  }
});

test("evidence without a projected source URL stays a truthful unavailable state", async () => {
  const snapshot = parseWorkbenchSnapshot(projectionWithEvidenceSource(undefined), projection.project.id);
  if (snapshot === null) throw new Error("Evidence projection should parse");
  const mounted = await mountProjectView({ state: "ready", snapshot });
  try {
    const opener = mounted.container.querySelector(".wb-paper-source");
    if (!(opener instanceof mounted.dom.window.HTMLButtonElement)) throw new Error("View original button not found");
    await act(async () => {
      (opener as unknown as HTMLButtonElement).click();
    });
    expect(mounted.container.textContent).toContain("No public source URL was included in this projection.");
    expect(mounted.container.querySelector('.wb-evidence-panel a[href]')).toBeNull();
  } finally {
    await mounted.cleanup();
  }
});

// -- F7 unsafe intake budget -------------------------------------------------

async function mountIntakeView(
  onIntake: (input: import("../workbench-state").WorkbenchIntakeInput) => Promise<import("../workbench-state").WorkbenchIntakeResult>,
): Promise<{
  readonly container: HTMLElement;
  readonly dom: HappyWindow;
  readonly cleanup: () => Promise<void>;
}> {
  const { WorkbenchIntakeView } = await import("../Workbench");
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
    root.render(createElement(WorkbenchIntakeView, { onIntake }));
  });
  return {
    container,
    dom,
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

async function submitIntakeBudget(
  container: HTMLElement,
  dom: HappyWindow,
  values: { readonly projectName: string; readonly region: string; readonly budget: string; readonly brief?: string },
): Promise<void> {
  const set = (name: string, value: string) => {
    const control = container.querySelector(`[name="${name}"]`);
    if (!(control instanceof dom.window.HTMLInputElement) && !(control instanceof dom.window.HTMLTextAreaElement)) {
      throw new Error(`Control not found: ${name}`);
    }
    (control as unknown as HTMLInputElement).value = value;
  };
  set("projectName", values.projectName);
  set("region", values.region);
  set("budget", values.budget);
  set("detailSummary", values.brief ?? "Open a coffee shop in Amsterdam; rent a place and buy everything needed.");
  const button = Array.from(container.querySelectorAll("button")).find((candidate) =>
    candidate.textContent?.includes("Create workspace"),
  );
  if (!(button instanceof dom.window.HTMLButtonElement)) throw new Error("Submit button not found");
  await act(async () => {
    (button as unknown as HTMLButtonElement).click();
  });
}

test("an unsafe intake budget shows an error, retains input, and never reaches intake", async () => {
  const seen: unknown[] = [];
  const mounted = await mountIntakeView(async (input) => {
    seen.push(input);
    return { ok: true, projectId: "project-unsafe" };
  });
  try {
    await submitIntakeBudget(mounted.container, mounted.dom, {
      projectName: "Northside café",
      region: "Amsterdam",
      budget: "99999999999999999.99",
    });
    expect(seen).toHaveLength(0);
    expect(mounted.container.textContent).toContain("too large to record safely");
    const budget = mounted.container.querySelector('[name="budget"]') as unknown as HTMLInputElement;
    expect(budget.value).toBe("99999999999999999.99");
    const project = mounted.container.querySelector('[name="projectName"]') as unknown as HTMLInputElement;
    expect(project.value).toBe("Northside café");
  } finally {
    await mounted.cleanup();
  }
});

test("an over-precision intake budget is rejected before the intake route", async () => {
  const seen: unknown[] = [];
  const mounted = await mountIntakeView(async (input) => {
    seen.push(input);
    return { ok: true, projectId: "project-precision" };
  });
  try {
    await submitIntakeBudget(mounted.container, mounted.dom, {
      projectName: "Northside café",
      region: "Amsterdam",
      budget: "45000.555",
    });
    expect(seen).toHaveLength(0);
    expect(mounted.container.textContent).toContain("up to two decimals");
  } finally {
    await mounted.cleanup();
  }
});

test("a valid intake budget still reaches the intake route in minor units", async () => {
  const seen: import("../workbench-state").WorkbenchIntakeInput[] = [];
  const mounted = await mountIntakeView(async (input) => {
    seen.push(input);
    return { ok: true, projectId: "project-valid" };
  });
  try {
    await submitIntakeBudget(mounted.container, mounted.dom, {
      projectName: "Northside café",
      region: "Amsterdam",
      budget: "45000.50",
    });
    expect(seen).toHaveLength(1);
    expect(seen[0]).toMatchObject({ budgetMinorUnits: 4500050 });
    expect(mounted.container.textContent).toContain("Workspace created. Loading the persisted project.");
  } finally {
    await mounted.cleanup();
  }
});

test("rejects malformed or partial controlled sample markers at the browser boundary", async () => {
  const projectId = projection.project.id;
  const valid = parseWorkbenchSnapshot({
    ...projection,
    project: { ...projection.project, sampleKind: "controlledSample", sampleLabel: "Controlled sample data" },
  }, projectId);
  if (valid === null) throw new Error("Controlled sample projection should parse");
  expect(valid.project.sampleKind).toBe("controlledSample");
  expect(valid.project.sampleLabel).toBe("Controlled sample data");
  expect(parseWorkbenchSnapshot({
    ...projection,
    project: { ...projection.project, sampleKind: "controlledSample" },
  }, projectId)).toBeNull();
  expect(parseWorkbenchSnapshot({
    ...projection,
    project: { ...projection.project, sampleLabel: "Controlled sample data" },
  }, projectId)).toBeNull();
  expect(parseWorkbenchSnapshot({
    ...projection,
    project: { ...projection.project, sampleKind: "liveSample", sampleLabel: "Controlled sample data" },
  }, projectId)).toBeNull();
  expect(parseWorkbenchSnapshot({
    ...projection,
    project: { ...projection.project, sampleKind: "controlledSample", sampleLabel: "   " },
  }, projectId)).toBeNull();
  expect(parseWorkbenchSnapshot({
    ...projection,
    project: { ...projection.project, sampleKind: "controlledSample", sampleLabel: 42 },
  }, projectId)).toBeNull();
  expect(parseWorkbenchSnapshot(projection, projectId)?.project.sampleKind ?? null).toBeNull();
});

test("renders the durable sample label for controlled projects and never for normal projects", async () => {
  const sampleSnapshot = parseWorkbenchSnapshot({
    ...projection,
    project: { ...projection.project, sampleKind: "controlledSample", sampleLabel: "Controlled sample data" },
  }, projection.project.id);
  if (sampleSnapshot === null) throw new Error("Sample projection should parse");
  const sampleHtml = renderToStaticMarkup(createElement(WorkbenchView, {
    loadState: { state: "ready", snapshot: sampleSnapshot },
  }));
  expect(sampleHtml).toContain("Controlled sample data");
  expect(sampleHtml).not.toContain("Live vendor");
  expect(sampleHtml).not.toContain("genuine quote");
  expect(sampleHtml).not.toContain("realized savings");

  const normalSnapshot = parseWorkbenchSnapshot(projection, projection.project.id);
  if (normalSnapshot === null) throw new Error("Normal projection should parse");
  const normalHtml = renderToStaticMarkup(createElement(WorkbenchView, {
    loadState: { state: "ready", snapshot: normalSnapshot },
  }));
  expect(normalHtml).not.toContain("Controlled sample data");
});

test("sample creation transitions an empty connected app to the returned project load", async () => {
  const sampleProjection = {
    ...projection,
    project: { ...projection.project, id: "project-sample-1", sampleKind: "controlledSample", sampleLabel: "Controlled sample data" },
  };
  const loads: string[] = [];
  const sampleCalls: { idempotencyKey: string }[] = [];
  const adapter = {
    load: async (projectId: string) => {
      loads.push(projectId);
      if (projectId === "project-sample-1") return sampleProjection;
      return null;
    },
    subscribe: (_projectId: string, onSnapshot: (snapshot: unknown) => void) => {
      onSnapshot(sampleProjection);
      return () => undefined;
    },
    act: async () => ({ ok: true }),
    discoverProject: async () => null,
    createSample: async (input: { idempotencyKey: string }) => {
      sampleCalls.push(input);
      return { ok: true, projectId: "project-sample-1", message: "Sample project created by the server." };
    },
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
  const findButton = (label: string): HTMLButtonElement => {
    const button = Array.from(container.querySelectorAll("button")).find((candidate) => candidate.textContent?.includes(label));
    if (!(button instanceof dom.window.HTMLButtonElement)) throw new Error(`Button not found: ${label}`);
    return button as unknown as HTMLButtonElement;
  };
  try {
    await act(async () => {
      root.render(createElement(AdapterAwareApp, {
        backendStatus: "connected",
        onRetry: () => undefined,
        workbenchAdapter: adapter,
      }));
    });
    const deadline = Date.now() + 1500;
    while (!container.textContent?.includes("NO AUTHORIZED PROJECT") && Date.now() < deadline) {
      await act(async () => {
        await new Promise((resolve) => setTimeout(resolve, 10));
      });
    }
    expect(container.textContent).toContain("NO AUTHORIZED PROJECT");
    expect(sampleCalls).toHaveLength(0);
    await act(async () => {
      findButton("Try the Northside").click();
    });
    const loadedDeadline = Date.now() + 1500;
    while (!loads.includes("project-sample-1") && Date.now() < loadedDeadline) {
      await act(async () => {
        await new Promise((resolve) => setTimeout(resolve, 10));
      });
    }
    expect(sampleCalls).toHaveLength(1);
    expect(sampleCalls[0]?.idempotencyKey.trim().length).toBeGreaterThan(0);
    expect(loads).toContain("project-sample-1");
    const viewDeadline = Date.now() + 1500;
    while (!container.textContent?.includes("Controlled sample data") && Date.now() < viewDeadline) {
      await act(async () => {
        await new Promise((resolve) => setTimeout(resolve, 10));
      });
    }
    expect(container.textContent).toContain("Controlled sample data");
    expect(container.textContent).not.toContain("Live vendor");
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

test("stale sample success never overwrites a newer project context", async () => {
  const newerProjection = {
    ...projection,
    project: { ...projection.project, id: "project-newer-1", name: "Newer authorized project" },
  };
  const loads: string[] = [];
  const sampleCalls: { idempotencyKey: string }[] = [];
  let resolveSample: ((value: { ok: boolean; projectId?: string; message?: string }) => void) | undefined;
  const sampleGate = new Promise<{ ok: boolean; projectId?: string; message?: string }>((resolve) => {
    resolveSample = resolve;
  });
  const adapter = {
    load: async (projectId: string) => {
      loads.push(projectId);
      if (projectId === "project-newer-1") return newerProjection;
      return null;
    },
    subscribe: (_projectId: string, _onSnapshot: (snapshot: unknown) => void, _onError: (error: unknown) => void) => () => undefined,
    act: async () => ({ ok: true }),
    discoverProject: async () => null,
    createSample: async (input: { idempotencyKey: string }) => {
      sampleCalls.push(input);
      return sampleGate;
    },
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
  const findButton = (label: string): HTMLButtonElement => {
    const button = Array.from(container.querySelectorAll("button")).find((candidate) => candidate.textContent?.includes(label));
    if (!(button instanceof dom.window.HTMLButtonElement)) throw new Error(`Button not found: ${label}`);
    return button as unknown as HTMLButtonElement;
  };
  try {
    await act(async () => {
      root.render(createElement(AdapterAwareApp, {
        backendStatus: "connected",
        onRetry: () => undefined,
        workbenchAdapter: adapter,
      }));
    });
    const emptyDeadline = Date.now() + 1500;
    while (!container.textContent?.includes("NO AUTHORIZED PROJECT") && Date.now() < emptyDeadline) {
      await act(async () => {
        await new Promise((resolve) => setTimeout(resolve, 10));
      });
    }
    expect(container.textContent).toContain("NO AUTHORIZED PROJECT");
    await act(async () => {
      findButton("Try the Northside").click();
    });
    const startedDeadline = Date.now() + 1500;
    while (sampleCalls.length === 0 && Date.now() < startedDeadline) {
      await act(async () => {
        await new Promise((resolve) => setTimeout(resolve, 10));
      });
    }
    expect(sampleCalls).toHaveLength(1);
    await act(async () => {
      root.render(createElement(AdapterAwareApp, {
        backendStatus: "connected",
        onRetry: () => undefined,
        projectId: "project-newer-1",
        workbenchAdapter: adapter,
      }));
    });
    const newerDeadline = Date.now() + 1500;
    while (!container.textContent?.includes("Newer authorized project") && Date.now() < newerDeadline) {
      await act(async () => {
        await new Promise((resolve) => setTimeout(resolve, 10));
      });
    }
    expect(container.textContent).toContain("Newer authorized project");
    await act(async () => {
      resolveSample?.({ ok: true, projectId: "project-sample-stale" });
      await sampleGate;
    });
    await act(async () => {
      await new Promise((resolve) => setTimeout(resolve, 10));
    });
    expect(sampleCalls).toHaveLength(1);
    expect(loads).not.toContain("project-sample-stale");
    expect(container.textContent).toContain("Newer authorized project");
    expect(container.textContent).not.toContain("Controlled sample data");
    const alert = container.querySelector('[role="alert"]');
    expect(alert?.textContent ?? "").toContain("may have been created");
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

// -- E16 workbench fidelity: decision desk above finance, paper-document cards --

test("E16 compare journey keeps the decision desk above finance with paper-document cards", () => {
  const snapshot = parseWorkbenchSnapshot(projection, projection.project.id);
  if (snapshot === null) throw new Error("W1 projection should parse");
  const html = renderToStaticMarkup(createElement(WorkbenchView, { loadState: { state: "ready", snapshot } }));
  expect(html).toContain("wb-bench-heading");
  expect(html).toContain("wb-desk-layout");
  expect(html).toContain("wb-project-lower");
  expect(html).toContain("Everything on the table.");
  expect(html).toContain("Unknown charges stay visible.");
  expect(html).toContain("An incomplete result is not ranked as a saving.");
  expect(html).toContain("All 1 results");
  const benchAt = html.indexOf("wb-bench-heading");
  const deskAt = html.indexOf("wb-desk-layout");
  const lowerAt = html.indexOf("wb-project-lower");
  expect(benchAt).toBeGreaterThanOrEqual(0);
  expect(deskAt).toBeGreaterThan(benchAt);
  expect(lowerAt).toBeGreaterThan(deskAt);
  // Paper-document hierarchy per card: vendor head, quote rule, charge lines, total, validity, action.
  const headAt = html.indexOf("wb-paper-head");
  const ruleAt = html.indexOf("wb-paper-rule");
  const chargesAt = html.indexOf("wb-charge-list");
  const totalAt = html.indexOf("wb-quote-total");
  const readyAt = html.indexOf("wb-paper-ready");
  const bottomAt = html.indexOf("wb-paper-bottom");
  expect(headAt).toBeGreaterThan(deskAt);
  expect(ruleAt).toBeGreaterThan(headAt);
  expect(chargesAt).toBeGreaterThan(ruleAt);
  expect(totalAt).toBeGreaterThan(chargesAt);
  expect(readyAt).toBeGreaterThan(totalAt);
  expect(bottomAt).toBeGreaterThan(readyAt);
  expect(bottomAt).toBeLessThan(lowerAt);
  // Honesty labels survive the denser layout.
  expect(html).toContain("Harbor Equipment");
  expect(html).toContain("Missing terms");
  expect(html).toContain("Validity not confirmed");
  expect(html).toContain("Unknown charges block an unqualified saving claim.");
  expect(html).toContain("Recorded owner exchange");
  expect(html).toContain("No order is placed.");
  expect(html).toContain("Selecting an offer does not place an order.");
});

test("E16 quote cards preserve explicit charge states with native money and validity", () => {
  const snapshot = parseWorkbenchSnapshot(twoOfferProjection(), projection.project.id);
  if (snapshot === null) throw new Error("Two-offer projection should parse");
  const html = renderToStaticMarkup(createElement(WorkbenchView, { loadState: { state: "ready", snapshot } }));
  expect(html).toContain("Total (EUR)");
  expect(html).toContain("Tax inclusive");
  expect(html).toContain("Validity not confirmed");
  expect(html).toContain("wb-paper-ready");
  expect(html).toContain("wb-paper-bottom");
  expect(html).toContain("Original quote document · View original");
  expect(html).not.toContain("Quoted total");
  // Estimated and not-applicable states never collapse to zero or a plain total.
  const estimated = parseWorkbenchSnapshot(withQuoteTotals(projectionWithCurrentCompleteQuote(), (quote) => ({
    ...quote,
    lines: [{ lineId: "machine", description: "Atlas 2G", quantity: "1", unitPrice: { currency: "EUR", minorUnits: 750000 } }],
    charges: [
      { chargeId: "charge-freight", label: "freight", scope: { kind: "quote" }, state: { kind: "estimated", estimate: { kind: "point", amount: { currency: "EUR", minorUnits: 60000 } } } },
      { chargeId: "charge-installation", label: "installation", scope: { kind: "quote" }, state: { kind: "notApplicable", reason: "Counter pickup has no installation." } },
    ],
  })), projection.project.id);
  if (estimated === null) throw new Error("Estimated projection should parse");
  const estimatedHtml = renderToStaticMarkup(createElement(WorkbenchView, { loadState: { state: "ready", snapshot: estimated } }));
  expect(estimatedHtml).toContain("Estimated");
  expect(estimatedHtml).toContain("Not applicable");
});

test("E16 responsive CSS keeps desk density without horizontal overflow", async () => {
  const css = await Bun.file(new URL("../styles.css", import.meta.url)).text();
  // Slim status strip keeps the desk above the fold.
  expect(css).toContain(".wb-compare { padding-top: 1rem;");
  expect(css).toContain(".wb-overview-intro strong { margin-top: .1rem;");
  // Bench heading carries the compare journey without the tall page heading.
  expect(css).toContain(".wb-bench-heading-actions");
  expect(css).toContain(".wb-compare .wb-scope-row { margin-bottom: .7rem;");
  // Paper-document density: tight kicker/tags, lines before total, ready + bottom rows.
  expect(css).toContain(".wb-paper-kicker { margin: .1875rem 0 .8rem;");
  expect(css).toContain(".wb-paper-ready");
  expect(css).toContain(".wb-paper-bottom");
  expect(css).toContain(".wb-desk-layout > .wb-load-more { grid-column: 1 / -1;");
  // Narrow viewports stack the desk with no rotated-paper overflow.
  const narrow = css.slice(css.indexOf("@media (max-width: 540px)"));
  expect(narrow).toContain(".wb-desk-layout { grid-template-columns: minmax(0, 1fr);");
  expect(narrow).toContain(".wb-desk-layout > .wb-empty { grid-column: 1;");
  expect(narrow).toContain("transform: none;");
});

// -- E16 repair: strict comparison consumer binding --------------------------

function twoOfferProjectionWithVerdicts(
  rewrite: (verdict: Record<string, unknown>, index: number) => Record<string, unknown>,
): Record<string, unknown> {
  const value = twoOfferProjection();
  const candidates = value.candidates as readonly Record<string, unknown>[];
  return {
    ...value,
    candidates: candidates.map((candidate, index) => ({
      ...candidate,
      comparisons: (candidate.comparisons as readonly Record<string, unknown>[]).map((verdict) => rewrite(verdict, index)),
    })),
  };
}

test("a verdict for the same candidate but an unrelated quote fails closed", () => {
  // Control: the backend-named opposing quote ids bind and the exact delta renders.
  const control = parseWorkbenchSnapshot(twoOfferProjection(), projection.project.id);
  if (control === null) throw new Error("Two-offer projection should parse");
  const controlHtml = renderToStaticMarkup(createElement(WorkbenchView, { loadState: { state: "ready", snapshot: control } }));
  expect(controlHtml).toContain("wb-comparison-tape");
  expect(controlHtml).toContain("549.51");

  // Same candidate ids, but the verdict names a quote that is not displayed.
  const stale = parseWorkbenchSnapshot(
    twoOfferProjectionWithVerdicts((verdict) => ({ ...verdict, againstQuoteId: "quote-stale-unrelated" })),
    projection.project.id,
  );
  expect(stale).toBeNull();

  // A verdict with no quote binding fails closed as well.
  const unbound = parseWorkbenchSnapshot(
    twoOfferProjectionWithVerdicts((verdict) => ({ ...verdict, againstQuoteId: null })),
    projection.project.id,
  );
  expect(unbound).toBeNull();
});

test("a verdict fails closed when the opposing quote is absent", () => {
  const value = twoOfferProjection();
  const candidates = value.candidates as readonly Record<string, unknown>[];
  const withoutOpposingQuote = parseWorkbenchSnapshot({
    ...value,
    candidates: candidates.map((candidate, index) => index === 1
      ? { ...candidate, latestValidQuote: null }
      : candidate),
  }, projection.project.id);
  expect(withoutOpposingQuote).toBeNull();
});

// -- E16 repair (F7): exact decimal-string intake budget parsing --------------

test("the safe-limit budget parses to exact minor units and is accepted", async () => {
  const seen: import("../workbench-state").WorkbenchIntakeInput[] = [];
  const mounted = await mountIntakeView(async (input) => {
    seen.push(input);
    return { ok: true, projectId: "project-safe-limit" };
  });
  try {
    await submitIntakeBudget(mounted.container, mounted.dom, {
      projectName: "Northside café",
      region: "Amsterdam",
      budget: "90071992547409.90",
    });
    expect(seen).toHaveLength(1);
    expect(seen[0]?.budgetMinorUnits).toBe(9007199254740990);
    expect(mounted.container.textContent).toContain("Workspace created. Loading the persisted project.");
  } finally {
    await mounted.cleanup();
  }
});

test("the exact safe-integer boundary budget is accepted without float drift", async () => {
  const seen: import("../workbench-state").WorkbenchIntakeInput[] = [];
  const mounted = await mountIntakeView(async (input) => {
    seen.push(input);
    return { ok: true, projectId: "project-boundary" };
  });
  try {
    await submitIntakeBudget(mounted.container, mounted.dom, {
      projectName: "Northside café",
      region: "Amsterdam",
      budget: "90071992547409.91",
    });
    expect(seen).toHaveLength(1);
    expect(seen[0]?.budgetMinorUnits).toBe(Number.MAX_SAFE_INTEGER);
  } finally {
    await mounted.cleanup();
  }
});

test("unsafe, malformed, and ambiguous budgets never reach the intake route", async () => {
  const rejected: readonly string[] = [
    "90071992547409.92",
    "99999999999999999.99",
    "45000.555",
    "1e3",
    "1E6",
    "+45000",
    "-45000",
    "NaN",
    "Infinity",
    "45 000",
    "$45000",
  ];
  for (const budget of rejected) {
    const seen: unknown[] = [];
    const mounted = await mountIntakeView(async (input) => {
      seen.push(input);
      return { ok: true, projectId: "project-rejected" };
    });
    try {
      await submitIntakeBudget(mounted.container, mounted.dom, {
        projectName: "Northside café",
        region: "Amsterdam",
        budget,
      });
      expect(seen).toHaveLength(0);
      const text = mounted.container.textContent ?? "";
      expect(text.includes("up to two decimals") || text.includes("too large to record safely")).toBe(true);
    } finally {
      await mounted.cleanup();
    }
  }
});

// -- Pixel QA iteration 2: overview below the decision bar on Project --------

test("the Project tab renders readiness and finance below the decision bar", () => {
  const snapshot = parseWorkbenchSnapshot(projection, projection.project.id);
  if (snapshot === null) throw new Error("W1 projection should parse");
  const html = renderToStaticMarkup(createElement(WorkbenchView, { loadState: { state: "ready", snapshot } }));
  expect(html).toContain("wb-overview-strip");
  expect(html).toContain("PROCUREMENT READINESS");
  expect(html).toContain("Approved budget");
  const deskAt = html.indexOf("wb-desk-layout");
  const actionAt = html.indexOf("wb-bench-action");
  const stripAt = html.indexOf("wb-overview-strip");
  const lowerAt = html.indexOf("wb-project-lower");
  expect(deskAt).toBeGreaterThanOrEqual(0);
  expect(actionAt).toBeGreaterThan(deskAt);
  expect(stripAt).toBeGreaterThan(actionAt);
  expect(lowerAt).toBeGreaterThan(stripAt);
  // No honesty data is dropped by the move.
  expect(html).toContain("Not assessed");
  expect(html).toContain("Selected forecast");
  expect(html).toContain("Committed");
});

test("non-Project tabs keep the readiness strip above the page content", async () => {
  const snapshot = parseWorkbenchSnapshot(projection, projection.project.id);
  if (snapshot === null) throw new Error("W1 projection should parse");
  const mounted = await mountE8Tab({ state: "ready", snapshot }, () => ({ ok: false, message: "controlled test refusal" }));
  try {
    await mounted.clickTab("Results");
    const app = mounted.container.querySelector(".wb-app");
    if (app === null) throw new Error("Workbench app not found");
    const appHtml = app.innerHTML;
    expect(appHtml).toContain("wb-overview-strip");
    expect(appHtml.indexOf("wb-overview-strip")).toBeLessThan(appHtml.indexOf('id="workbench-main"'));
  } finally {
    await mounted.cleanup();
  }
});

// -- Pixel QA iteration 2: compact controlled-fixture card headings ----------

function controlledNameProjection(): Record<string, unknown> {
  const value = twoOfferProjection();
  const candidates = value.candidates as readonly Record<string, unknown>[];
  const first = candidates[0]!;
  const second = candidates[1]!;
  return {
    ...value,
    candidates: [
      {
        ...first,
        vendor: { id: "vendor-controlled-1", name: "Sample Vendor A (controlled demo)", regions: ["NL"], serviceCoverage: "Service coverage reported for this inquiry" },
        provenance: { mode: "fixture", label: "Controlled fixture evidence", ownerAuthoredTerms: true },
      },
      {
        ...second,
        vendor: { id: "vendor-live-2", name: "Harbor Equipment (EU Satellite)", regions: ["NL"], serviceCoverage: "Service coverage reported for this inquiry" },
        provenance: { mode: "live", label: "Live provider result", ownerAuthoredTerms: false },
      },
    ],
  };
}

test("controlled fixture headings stay concise while the full name remains available", () => {
  const snapshot = parseWorkbenchSnapshot(controlledNameProjection(), projection.project.id);
  if (snapshot === null) throw new Error("Controlled-name projection should parse");
  const html = renderToStaticMarkup(createElement(WorkbenchView, { loadState: { state: "ready", snapshot } }));
  // Concise visible heading with the full name retained for assistive use.
  expect(html).toContain(">Sample Vendor A</h3>");
  expect(html).toContain('title="Sample Vendor A (controlled demo)"');
  expect(html).toContain("Review quote from Sample Vendor A (controlled demo)");
  // The honesty pill stays on the same card.
  expect(html).toContain("Controlled fixture evidence");
  // A live vendor keeps its full display name.
  expect(html).toContain(">Harbor Equipment (EU Satellite)</h3>");
  expect(html).toContain("Live provider result");
});

test("pixel-QA CSS keeps the tape and decision bar above the fold", async () => {
  const css = await Bun.file(new URL("../styles.css", import.meta.url)).text();
  // The real strip follows the decision bar instead of consuming top height.
  expect(css).toContain(".wb-compare .wb-overview-strip { margin-top: 1.5rem;");
  // Paper headings recover source density without hiding controlled labels.
  expect(css).toContain(".wb-offer-header .wb-pill { margin-top: .35rem;");
  expect(css).toContain(".wb-offer-card .wb-pill { font-size: .55rem;");
  expect(css).not.toMatch(/\.wb-paper-version \{[^}]*white-space:\s*nowrap/);
  // Tightened paper rhythm and decision-bar placement.
  expect(css).toContain(".wb-quote-total strong { font-family: var(--wb-serif); font-size: 1.45rem;");
  expect(css).toContain("margin: .7rem auto 1.2rem;");
  expect(css).toContain(".wb-bench-action { display: grid; grid-column: 1 / -1;");
  expect(css).toContain("margin: 1rem -2.625rem 0;");
});

// -- Mobile 390px fidelity: compact header, metadata, and product row --------

test("narrow CSS compacts identity, heading, and product cards toward the first quote", async () => {
  const css = await Bun.file(new URL("../styles.css", import.meta.url)).text();
  const phone = css.slice(css.indexOf("@media (max-width: 480px)"));
  // Project identity folds into the main header row instead of a tall block.
  expect(phone).toContain(".wb-header { display: grid;");
  expect(phone).toContain(".wb-project-picker { grid-row: 1; grid-column: 2;");
  expect(phone).toContain(".wb-project-picker .wb-eyebrow { display: none;");
  expect(phone).toContain(".wb-project-picker > span:last-child { display: none;");
  expect(phone).toContain(".wb-nav { grid-row: 2;");
  // Touch targets stay usable.
  expect(phone).toContain(".wb-nav button { min-width: 0; flex: 1 1 20%;");
  // Heading and metadata reflow without hiding copy.
  expect(phone).toContain(".wb-bench-heading h1 { max-width: 100%; font-size: clamp(2rem, 10.5vw, 2.5rem);");
  expect(phone).toContain(".wb-bench-heading p { font-size: .72rem; line-height: 1.55; }");
  expect(phone).toContain(".wb-bench-heading-actions .wb-button { min-height: 2.4rem;");
  // Asset and on-your-list cards share one compact row so the first quote
  // starts near the prototype position.
  expect(phone).toContain(".wb-desk-product { display: grid; grid-column: 1; grid-template-columns: minmax(0, 1fr) minmax(0, 1fr);");
  expect(phone).toContain(".wb-polaroid { width: auto;");
  expect(phone).toContain(".wb-scope-note h2 { font-size: 1.05rem; }");
});

test("narrow CSS hides no honest project, scope, or quote state from the markup", () => {
  const snapshot = parseWorkbenchSnapshot(
    {
      ...projection,
      project: { ...projection.project, sampleKind: "controlledSample", sampleLabel: "Controlled sample data" },
    },
    projection.project.id,
  );
  if (snapshot === null) throw new Error("Sample projection should parse");
  const html = renderToStaticMarkup(createElement(WorkbenchView, { loadState: { state: "ready", snapshot } }));
  // Narrow rules use display:none for duplicated decoration only; every
  // honest fact below remains in the markup for all viewports.
  for (const fact of [
    "Northside caf",
    "Controlled sample data",
    "Netherlands",
    "EUR",
    "Need by",
    "Recorded owner exchange",
    "Two-group espresso machine",
    "ON YOUR LIST",
    "Allocation",
    "Harbor Equipment",
    "Missing terms",
    "Validity not confirmed",
    "Unknown charges block an unqualified saving claim.",
    "Review selected result",
    "Ask about these results",
    "No order is placed.",
  ]) {
    expect(html).toContain(fact);
  }
});

// -- Opening brief intake (P-01 opening mode) ---------------------------------

function intakeField(
  container: HTMLElement,
  dom: HappyWindow,
  label: string,
): HTMLInputElement | HTMLTextAreaElement | HTMLSelectElement {
  const match = Array.from(container.querySelectorAll("label")).find(
    (candidate) => candidate.textContent === label,
  );
  if (match === undefined || match.htmlFor.length === 0) throw new Error(`Label not found: ${label}`);
  const control = container.querySelector(`#${match.htmlFor}`);
  if (
    !(control instanceof dom.window.HTMLInputElement) &&
    !(control instanceof dom.window.HTMLTextAreaElement) &&
    !(control instanceof dom.window.HTMLSelectElement)
  ) {
    throw new Error(`Control not found for label: ${label}`);
  }
  return control as unknown as HTMLInputElement | HTMLTextAreaElement | HTMLSelectElement;
}

async function submitMountedIntake(container: HTMLElement, dom: HappyWindow): Promise<void> {
  const button = Array.from(container.querySelectorAll("button")).find((candidate) =>
    candidate.textContent?.includes("Create workspace"),
  );
  if (!(button instanceof dom.window.HTMLButtonElement)) throw new Error("Submit button not found");
  await act(async () => {
    (button as unknown as HTMLButtonElement).click();
  });
}

async function switchIntakeMode(container: HTMLElement, dom: HappyWindow, mode: string): Promise<void> {
  const radio = container.querySelector(`input[type="radio"][value="${mode}"]`);
  if (!(radio instanceof dom.window.HTMLInputElement)) throw new Error(`Intake mode radio not found: ${mode}`);
  await act(async () => {
    (radio as unknown as HTMLInputElement).click();
  });
}

function hasIntakeLabel(container: HTMLElement, label: string): boolean {
  return Array.from(container.querySelectorAll("label")).some(
    (candidate) => candidate.textContent === label,
  );
}

test("opening mode exposes the brief, title, category, and a currency-neutral ceiling", async () => {
  const mounted = await mountIntakeView(async () => ({ ok: true, projectId: "project-labels" }));
  try {
    const brief = intakeField(mounted.container, mounted.dom, "Opening brief");
    expect(brief.tagName.toLowerCase()).toBe("textarea");
    expect(brief.closest(".wb-form-field")?.classList.contains("wb-form-field-full")).toBe(true);
    expect((brief as unknown as HTMLTextAreaElement).placeholder).toContain("San Francisco");
    intakeField(mounted.container, mounted.dom, "Opening title (optional)");
    intakeField(mounted.container, mounted.dom, "Opening category (optional)");
    intakeField(mounted.container, mounted.dom, "Budget upper limit in reporting currency (optional)");
    const text = mounted.container.textContent ?? "";
    expect(text.toLowerCase()).not.toContain("euro");
    expect(text).toContain("2000 characters maximum");
  } finally {
    await mounted.cleanup();
  }
});

test("an empty opening brief blocks submission without reaching intake", async () => {
  const seen: import("../workbench-state").WorkbenchIntakeInput[] = [];
  const mounted = await mountIntakeView(async (input) => {
    seen.push(input);
    return { ok: true, projectId: "project-blocked" };
  });
  try {
    const set = (label: string, value: string) => {
      (intakeField(mounted.container, mounted.dom, label) as unknown as HTMLInputElement).value = value;
    };
    set("Project name", "Harbor coffee opening");
    set("City or region", "San Francisco, USA");
    await submitMountedIntake(mounted.container, mounted.dom);
    expect(seen).toHaveLength(0);
    expect(mounted.container.textContent).toContain("opening brief");
    expect((intakeField(mounted.container, mounted.dom, "Project name") as unknown as HTMLInputElement).value).toBe("Harbor coffee opening");

    set("Opening brief", "   ");
    await submitMountedIntake(mounted.container, mounted.dom);
    expect(seen).toHaveLength(0);
    expect(mounted.container.textContent).toContain("opening brief");
  } finally {
    await mounted.cleanup();
  }
});

test("a short non-whitespace opening brief is accepted and preserved exactly", async () => {
  const seen: import("../workbench-state").WorkbenchIntakeInput[] = [];
  const mounted = await mountIntakeView(async (input) => {
    seen.push(input);
    return { ok: true, projectId: "project-short-brief" };
  });
  try {
    const set = (label: string, value: string) => {
      (intakeField(mounted.container, mounted.dom, label) as unknown as HTMLInputElement).value = value;
    };
    set("Project name", "Harbor coffee opening");
    set("City or region", "San Francisco, USA");
    set("Opening brief", "  Café?  ");
    await submitMountedIntake(mounted.container, mounted.dom);
    expect(seen).toHaveLength(1);
    expect(seen[0]).toMatchObject({ mode: "opening", detailSummary: "Café?" });
    expect(mounted.container.textContent).toContain("Workspace created. Loading the persisted project.");
  } finally {
    await mounted.cleanup();
  }
});

test("exact opening detail values and a USD ceiling reach intake once", async () => {
  const seen: import("../workbench-state").WorkbenchIntakeInput[] = [];
  const mounted = await mountIntakeView(async (input) => {
    seen.push(input);
    return { ok: true, projectId: "project-opening-brief" };
  });
  try {
    const set = (label: string, value: string) => {
      (intakeField(mounted.container, mounted.dom, label) as unknown as HTMLInputElement).value = value;
    };
    set("Project name", "Harbor coffee opening");
    set("City or region", "San Francisco, USA");
    set("Reporting currency", "USD");
    set("Budget upper limit in reporting currency (optional)", "500000");
    set("Opening title (optional)", "San Francisco coffee shop");
    set("Opening category (optional)", "café opening");
    set(
      "Opening brief",
      "  Open a coffee shop in San Francisco; rent a place and buy everything needed; budget USD 250,000-500,000  ",
    );
    await submitMountedIntake(mounted.container, mounted.dom);
    expect(seen).toHaveLength(1);
    expect(seen[0]).toEqual({
      mode: "opening",
      projectName: "Harbor coffee opening",
      workspaceKind: "private",
      region: "San Francisco, USA",
      currency: "USD",
      budgetMinorUnits: 50000000,
      detailTitle: "San Francisco coffee shop",
      detailCategory: "café opening",
      detailSummary: "Open a coffee shop in San Francisco; rent a place and buy everything needed; budget USD 250,000-500,000",
      idempotencyKey: expect.any(String),
    });
    expect(mounted.container.textContent).toContain("Workspace created. Loading the persisted project.");
  } finally {
    await mounted.cleanup();
  }
});

test("quote and equipment modes keep their own fields without the opening brief", async () => {
  const seen: import("../workbench-state").WorkbenchIntakeInput[] = [];
  const mounted = await mountIntakeView(async (input) => {
    seen.push(input);
    return { ok: true, projectId: "project-other-modes" };
  });
  try {
    const set = (label: string, value: string) => {
      (intakeField(mounted.container, mounted.dom, label) as unknown as HTMLInputElement).value = value;
    };
    await switchIntakeMode(mounted.container, mounted.dom, "quoteComparison");
    expect(mounted.container.textContent).toContain("Requirement subject");
    expect(hasIntakeLabel(mounted.container, "Opening brief")).toBe(false);
    set("Project name", "Quote review");
    set("Requirement subject", "Two-group espresso machine");
    await submitMountedIntake(mounted.container, mounted.dom);
    expect(seen).toHaveLength(1);
    expect(seen[0]).toMatchObject({ mode: "quoteComparison", detailTitle: "Two-group espresso machine" });
    expect("detailSummary" in seen[0]!).toBe(false);

    await switchIntakeMode(mounted.container, mounted.dom, "equipment");
    expect(mounted.container.textContent).toContain("Equipment label");
    expect(mounted.container.textContent).toContain("What needs attention?");
    expect(hasIntakeLabel(mounted.container, "Opening brief")).toBe(false);
    set("Project name", "Bar service");
    set("Equipment label", "Atlas grinder");
    set("What needs attention?", "Burrs need replacement.");
    await submitMountedIntake(mounted.container, mounted.dom);
    expect(seen).toHaveLength(2);
    expect(seen[1]).toMatchObject({
      mode: "equipment",
      detailTitle: "Atlas grinder",
      detailSummary: "Burrs need replacement.",
    });
  } finally {
    await mounted.cleanup();
  }
});

// -- Astra honest live-result UX: research semantics, gated review, recovery --

function researchLeadProjection(): Record<string, unknown> {
  const base = projection as unknown as Record<string, unknown>;
  const template = (base.candidates as readonly Record<string, unknown>[])[0]!;
  const evidence = (template.evidence as readonly Record<string, unknown>[])[0]!;
  return {
    ...base,
    candidates: [{
      id: "candidate-research-1",
      requirementId: "requirement-w1-1",
      productModel: "Two-group espresso machines",
      variant: "research lead",
      compatibility: "unknown",
      conversationState: "researchCollected",
      latestValidQuote: null,
      evidence: [{
        ...evidence,
        id: "research-evidence-1",
        field: "espresso machines",
        sourceKind: "firecrawl.search",
        sourceUrl: "https://www.reddit.com/r/restaurantowners/comments/1bcfts9",
        verification: "unverified",
        freshness: "fresh",
        counterpartyRole: "researchSource",
        executionMode: "live",
      }],
      provenance: { mode: "live", label: "Live provider result", ownerAuthoredTerms: false },
    }],
  };
}

test("generic research leads are never labeled suppliers, offers, or quotes", () => {
  const snapshot = parseWorkbenchSnapshot(researchLeadProjection(), projection.project.id);
  if (snapshot === null) throw new Error("Research-lead projection should parse");
  expect(snapshot.offers).toHaveLength(1);
  expect(hasCurrentReviewableQuote(snapshot.offers[0]!)).toBe(false);
  const html = renderToStaticMarkup(createElement(WorkbenchView, { loadState: { state: "ready", snapshot } }));
  expect(html).toContain("All 1 results");
  expect(html).not.toContain("All 1 suppliers");
  expect(html).not.toContain("suppliers");
  expect(html).toContain("Unnamed research result");
  expect(html).toContain("Source record · View source");
  expect(html).not.toContain("Original quote document");
  expect(html).not.toContain("Review quote from");
  expect(html).toContain("Review unavailable");
  expect(html).toContain("No reviewable result");
});

test("a generic web source stays a source record even when quote terms exist", () => {
  const base = projection as unknown as Record<string, unknown>;
  const template = (base.candidates as readonly Record<string, unknown>[])[0]!;
  const evidence = (template.evidence as readonly Record<string, unknown>[])[0]!;
  const snapshot = parseWorkbenchSnapshot({
    ...base,
    candidates: [{
      ...template,
      evidence: [{ ...evidence, sourceKind: "firecrawl.search", sourceUrl: "https://www.reddit.com/r/restaurantowners/comments/1bcfts9" }],
    }],
  }, projection.project.id);
  if (snapshot === null) throw new Error("Firecrawl-evidence projection should parse");
  const html = renderToStaticMarkup(createElement(WorkbenchView, { loadState: { state: "ready", snapshot } }));
  expect(html).toContain("Source record · View source");
  expect(html).not.toContain("Original quote document");
});

test("hasCurrentReviewableQuote gates on vendor, compatibility, currency, and basis", () => {
  const control = parseWorkbenchSnapshot(twoOfferProjection(), projection.project.id);
  if (control === null) throw new Error("Two-offer projection should parse");
  expect(control.offers.length).toBeGreaterThan(0);
  expect(control.offers.every((offer) => hasCurrentReviewableQuote(offer))).toBe(true);
  const incomplete = parseWorkbenchSnapshot(projection, projection.project.id);
  if (incomplete === null) throw new Error("W1 projection should parse");
  expect(incomplete.offers.every((offer) => hasCurrentReviewableQuote(offer))).toBe(false);
});

test("recovery states show retained evidence, honest next steps, and no fake retry", async () => {
  const snapshot = parseWorkbenchSnapshot(projection, projection.project.id);
  if (snapshot === null) throw new Error("W1 projection should parse");
  const mounted = await mountE8Tab({ state: "ready", snapshot }, () => ({ ok: false, message: "controlled test refusal" }));
  try {
    await mounted.clickTab("Recovery");
    const text = mounted.container.textContent ?? "";
    expect(text).toContain("Partial provider outcome");
    expect(text).toContain("reservation is retained");
    expect(text).toContain("Retained in this projection: 1 of 1 visible results carry recorded evidence.");
    expect(text).toContain("No model continuation is running.");
    expect(text).toContain("never resent automatically");
    const buttons = Array.from(mounted.container.querySelectorAll("button")).map((button) => button.textContent ?? "");
    expect(buttons.some((label) => label.includes("Retry bounded branch"))).toBe(false);
  } finally {
    await mounted.cleanup();
  }
});
