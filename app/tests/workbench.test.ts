import { expect, test } from "bun:test";
import { Window as HappyWindow } from "happy-dom";
import { createElement } from "react";
import { act } from "react";
import { createRoot } from "react-dom/client";
import { renderToStaticMarkup } from "react-dom/server";
import App from "../App";
import WorkbenchView from "../Workbench";
import { appendWorkbenchActivity } from "../main";
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
  onAction: (action: WorkbenchAction) => WorkbenchActionResult,
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

test("renders real assets with documents, cases, truncation, and a disabled service action", async () => {
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
    expect(serviceButton.disabled).toBe(true);
    expect(serviceButton.title).toContain("no backend command route exists");
    await act(async () => {
      serviceButton.click();
    });
    expect(actionCalls).toEqual([]);
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
