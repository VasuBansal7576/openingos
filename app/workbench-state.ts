/**
 * UI-owned boundary for the project-scoped purchasing projection.
 *
 * The browser never receives recipient addresses, raw message headers, or
 * provider credentials. The backend adapter must return this redacted shape
 * after checking project authority; the view only renders the projection.
 */

export type ProvenanceMode = "controlled" | "recorded" | "live";

export type DeliveryState = "queued" | "sent" | "delivered" | "unknown" | "partial" | "paused";

export type WorkbenchLoadState =
  | { readonly state: "loading"; readonly lastKnown?: WorkbenchSnapshot }
  | { readonly state: "ready"; readonly snapshot: WorkbenchSnapshot }
  | { readonly state: "empty"; readonly message: string }
  | { readonly state: "error"; readonly message: string; readonly lastKnown?: WorkbenchSnapshot }
  | { readonly state: "reconnecting"; readonly lastKnown?: WorkbenchSnapshot };

export type WorkbenchRole = "viewer" | "contributor" | "approver" | "owner";

export interface WorkbenchCapabilities {
  readonly canResearch: boolean;
  readonly canApprove: boolean;
  readonly canCommunicate: boolean;
  readonly canRecordOrder: boolean;
  readonly canResolveRisk: boolean;
}

export interface WorkbenchProject {
  readonly id: string;
  readonly name: string;
  readonly region: string;
  readonly currency: string;
  readonly budgetMinorUnits: number | null;
  readonly needByAt: number | null;
}

export interface WorkbenchAccess {
  readonly role: WorkbenchRole;
  readonly capabilities: WorkbenchCapabilities;
}

export interface WorkbenchRequirement {
  readonly id: string;
  readonly key: string;
  readonly title: string;
  readonly quantity: string;
  readonly unit: string;
  readonly priority: "P0" | "P1" | "P2";
  readonly state: "draft" | "approved" | "sourcing" | "readyForDecision" | "selected" | "fulfilled" | "cancelled";
  readonly fulfillment: "notOrdered" | "ordered" | "partiallyDelivered" | "delivered" | "installed" | "commissioned" | "cancelled";
  readonly version: number;
  readonly budgetMinorUnits: number | null;
  readonly needByAt: number | null;
}

export type Compatibility = "pass" | "fail" | "unknown";

export interface WorkbenchVendor {
  readonly id: string;
  readonly name: string;
  readonly regions: readonly string[];
  readonly serviceCoverage: string | null;
}

export type ChargeState = "known" | "included" | "estimated" | "unknown" | "notApplicable";

export interface WorkbenchQuoteLine {
  readonly lineId: string;
  readonly description: string;
  readonly quantity: string;
  readonly unit: string;
  readonly unitMinorUnits: number | null;
  readonly evidenceIds: readonly string[];
}

export interface WorkbenchQuoteCharge {
  readonly kind: string;
  readonly state: ChargeState;
  readonly minorUnits: number | null;
  readonly currency: string;
  readonly scope: string;
  readonly evidenceIds: readonly string[];
}

export interface WorkbenchQuote {
  readonly id: string;
  readonly version: string;
  readonly currency: string;
  readonly lines: readonly WorkbenchQuoteLine[];
  readonly charges: readonly WorkbenchQuoteCharge[];
  readonly totalMinorUnits: number | null;
  readonly comparableTotalMinorUnits: number | null;
  readonly validUntil: number | null;
  readonly taxBasis: "inclusive" | "exclusive" | "unknown";
  readonly superseded: boolean;
}

export interface WorkbenchEvidence {
  readonly id: string;
  readonly label: string;
  readonly sourceKind: string;
  readonly freshness: "fresh" | "stale" | "expired" | "unknown";
  readonly verification: "unverified" | "verified" | "conflicted" | "superseded";
  readonly executionMode: ProvenanceMode;
  readonly counterpartyRole: "vendor" | "ownerStandIn" | "userImport";
  readonly origin: "internal" | "ownerImport";
  readonly sourceUrl: string | null;
}

export interface WorkbenchOffer {
  readonly id: string;
  readonly requirementId: string;
  readonly vendor: WorkbenchVendor;
  readonly productModel: string;
  readonly variant: string;
  readonly compatibility: Compatibility;
  readonly conversationState: "draft" | "awaitingReply" | "clarificationNeeded" | "quoteReceived" | "negotiating" | "closed";
  readonly quote: WorkbenchQuote | null;
  readonly evidence: readonly WorkbenchEvidence[];
  readonly provenance: ProvenanceMode;
  readonly ownerAuthoredTerms: boolean;
  readonly recommendationNote: string | null;
}

export type JobKind = "research" | "communication" | "browser" | "recovery";

export interface WorkbenchJob {
  readonly id: string;
  readonly kind: JobKind;
  readonly state: "queued" | "running" | "completed" | "cancelled" | "failed" | "paused" | "waiting";
  readonly delivery: DeliveryState;
  readonly progress: number | null;
  readonly attempts: number;
  readonly updatedAt: number;
  readonly failureCode: string | null;
  readonly lastCheckedAt: number | null;
  readonly summary: string;
  readonly evidenceIds: readonly string[];
}

export interface WorkbenchDecision {
  readonly id: string;
  readonly type: "selection" | "approval" | "recipient" | "recovery" | "risk";
  readonly state: "requested" | "approved" | "rejected" | "invalidated" | "resolved";
  readonly requirementId: string | null;
  readonly offerId: string | null;
  readonly quoteId: string | null;
  readonly quoteVersion: string | null;
  readonly requestedAt: number;
  readonly evidenceIds: readonly string[];
  readonly summary: string;
  readonly authorizationRequired: boolean;
}

export interface WorkbenchActivityItem {
  readonly id: string;
  readonly type: string;
  readonly occurredAt: number;
  readonly actorLabel: string;
  readonly state: "recorded" | "pending" | "unknown" | "failed";
  readonly summary: string;
  readonly evidenceIds: readonly string[];
}

export interface WorkbenchActivityPage {
  readonly items: readonly WorkbenchActivityItem[];
  readonly continueCursor: string | null;
  readonly isDone: boolean;
}

export interface WorkbenchProvenance {
  readonly mode: ProvenanceMode;
  readonly label: string;
  readonly ownerAuthoredTerms: boolean;
}

export interface WorkbenchSnapshot {
  readonly project: WorkbenchProject;
  readonly access: WorkbenchAccess;
  readonly requirements: readonly WorkbenchRequirement[];
  readonly offers: readonly WorkbenchOffer[];
  readonly jobs: readonly WorkbenchJob[];
  readonly decisions: readonly WorkbenchDecision[];
  readonly activity: WorkbenchActivityPage;
  readonly provenance: WorkbenchProvenance;
  readonly selectedOfferId: string | null;
  readonly selectedForecastMinorUnits: number | null;
  readonly committedMinorUnits: number;
  readonly paidMinorUnits: number;
  readonly deliveredQuantityByRequirement: Readonly<Record<string, string>>;
}

export type WorkbenchAction =
  | { readonly type: "startResearch"; readonly projectId: string }
  | { readonly type: "retryJob"; readonly projectId: string; readonly jobId: string }
  | { readonly type: "cancelJob"; readonly projectId: string; readonly jobId: string }
  | { readonly type: "selectOffer"; readonly projectId: string; readonly offerId: string; readonly quoteId: string; readonly quoteVersion: string }
  | { readonly type: "approveDecision"; readonly projectId: string; readonly decisionId: string }
  | { readonly type: "openEvidence"; readonly projectId: string; readonly evidenceId: string };

export interface WorkbenchActionResult {
  readonly ok: boolean;
  readonly message?: string;
}

export interface WorkbenchServerAdapter {
  readonly load: (projectId: string, cursor?: string | null) => Promise<WorkbenchSnapshot | null>;
  readonly subscribe?: (projectId: string, onSnapshot: (snapshot: WorkbenchSnapshot | null) => void, onError: (error: unknown) => void) => (() => void);
  readonly act: (action: WorkbenchAction) => Promise<WorkbenchActionResult>;
}

export function formatMoney(minorUnits: number | null, currency: string, unknownLabel = "Unknown"): string {
  if (minorUnits === null || !Number.isFinite(minorUnits)) return unknownLabel;
  try {
    return new Intl.NumberFormat("en-GB", { style: "currency", currency, maximumFractionDigits: 0 }).format(minorUnits / 100);
  } catch {
    return `${currency} ${(minorUnits / 100).toFixed(0)}`;
  }
}

export function formatDate(timestamp: number | null): string {
  if (timestamp === null || !Number.isFinite(timestamp)) return "Date unknown";
  return new Intl.DateTimeFormat("en-GB", { day: "numeric", month: "short", year: "numeric" }).format(timestamp);
}

export function provenanceLabel(mode: ProvenanceMode): string {
  switch (mode) {
    case "controlled":
      return "Controlled evidence";
    case "recorded":
      return "Recorded owner exchange";
    case "live":
      return "Live provider result";
  }
}

export function deliveryLabel(state: DeliveryState): string {
  switch (state) {
    case "queued":
      return "Queued";
    case "sent":
      return "Sent, awaiting delivery receipt";
    case "delivered":
      return "Delivered";
    case "unknown":
      return "Outcome unknown";
    case "partial":
      return "Partially completed";
    case "paused":
      return "Paused for review";
  }
}

export function formatStateLabel(value: string): string {
  return value
    .replace(/([a-z])([A-Z])/g, "$1 $2")
    .replace(/[-_]/g, " ")
    .replace(/^./, (character) => character.toUpperCase());
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}

function isFiniteNumber(value: unknown): value is number {
  return typeof value === "number" && Number.isFinite(value);
}

function nullableNumber(value: unknown): number | null | undefined {
  if (value === null) return null;
  return isFiniteNumber(value) ? value : undefined;
}

function nullableString(value: unknown): string | null | undefined {
  if (value === null) return null;
  return typeof value === "string" ? value : undefined;
}

function isOneOf<T extends string>(value: unknown, options: readonly T[]): value is T {
  return options.some((option) => option === value);
}

function stringArray(value: unknown): readonly string[] | null {
  if (!Array.isArray(value) || !value.every((entry) => typeof entry === "string")) return null;
  return value;
}

function parseEvidence(value: unknown): WorkbenchEvidence | null {
  if (!isRecord(value)) return null;
  const id = typeof value.id === "string" ? value.id : null;
  const label = typeof value.label === "string" ? value.label : null;
  const sourceKind = typeof value.sourceKind === "string" ? value.sourceKind : null;
  if (id === null || label === null || sourceKind === null) return null;
  if (!isOneOf(value.freshness, ["fresh", "stale", "expired", "unknown"] as const)) return null;
  if (!isOneOf(value.verification, ["unverified", "verified", "conflicted", "superseded"] as const)) return null;
  if (!isOneOf(value.executionMode, ["controlled", "recorded", "live"] as const)) return null;
  if (!isOneOf(value.counterpartyRole, ["vendor", "ownerStandIn", "userImport"] as const)) return null;
  if (!isOneOf(value.origin, ["internal", "ownerImport"] as const)) return null;
  const sourceUrl = nullableString(value.sourceUrl);
  if (sourceUrl === undefined) return null;
  return { id, label, sourceKind, freshness: value.freshness, verification: value.verification, executionMode: value.executionMode, counterpartyRole: value.counterpartyRole, origin: value.origin, sourceUrl };
}

function parseQuote(value: unknown): WorkbenchQuote | null {
  if (!isRecord(value)) return null;
  const id = typeof value.id === "string" ? value.id : null;
  const version = typeof value.version === "string" ? value.version : null;
  const currency = typeof value.currency === "string" ? value.currency : null;
  if (id === null || version === null || currency === null) return null;
  if (!Array.isArray(value.lines) || !Array.isArray(value.charges) || !isOneOf(value.taxBasis, ["inclusive", "exclusive", "unknown"] as const) || typeof value.superseded !== "boolean") return null;
  const totalMinorUnits = nullableNumber(value.totalMinorUnits);
  const comparableTotalMinorUnits = nullableNumber(value.comparableTotalMinorUnits);
  const validUntil = nullableNumber(value.validUntil);
  if (totalMinorUnits === undefined || comparableTotalMinorUnits === undefined || validUntil === undefined) return null;
  const lines: WorkbenchQuoteLine[] = [];
  for (const entry of value.lines) {
    if (!isRecord(entry)) return null;
    const lineId = typeof entry.lineId === "string" ? entry.lineId : null;
    const description = typeof entry.description === "string" ? entry.description : null;
    const quantity = typeof entry.quantity === "string" ? entry.quantity : null;
    const unit = typeof entry.unit === "string" ? entry.unit : null;
    if (lineId === null || description === null || quantity === null || unit === null) return null;
    const unitMinorUnits = nullableNumber(entry.unitMinorUnits);
    const evidenceIds = stringArray(entry.evidenceIds);
    if (unitMinorUnits === undefined || evidenceIds === null) return null;
    lines.push({ lineId, description, quantity, unit, unitMinorUnits, evidenceIds });
  }
  const charges: WorkbenchQuoteCharge[] = [];
  for (const entry of value.charges) {
    if (!isRecord(entry)) return null;
    const kind = typeof entry.kind === "string" ? entry.kind : null;
    const chargeCurrency = typeof entry.currency === "string" ? entry.currency : null;
    const scope = typeof entry.scope === "string" ? entry.scope : null;
    if (kind === null || chargeCurrency === null || scope === null || !isOneOf(entry.state, ["known", "included", "estimated", "unknown", "notApplicable"] as const)) return null;
    const minorUnits = nullableNumber(entry.minorUnits);
    const evidenceIds = stringArray(entry.evidenceIds);
    if (minorUnits === undefined || evidenceIds === null) return null;
    if ((entry.state === "known" || entry.state === "estimated") && minorUnits === null) return null;
    if (entry.state === "unknown" && minorUnits !== null) return null;
    charges.push({ kind, state: entry.state, minorUnits, currency: chargeCurrency, scope, evidenceIds });
  }
  return { id, version, currency, lines, charges, totalMinorUnits, comparableTotalMinorUnits, validUntil, taxBasis: value.taxBasis, superseded: value.superseded };
}

function parseOffer(value: unknown): WorkbenchOffer | null {
  if (!isRecord(value)) return null;
  const id = typeof value.id === "string" ? value.id : null;
  const requirementId = typeof value.requirementId === "string" ? value.requirementId : null;
  const productModel = typeof value.productModel === "string" ? value.productModel : null;
  const variant = typeof value.variant === "string" ? value.variant : null;
  if (id === null || requirementId === null || productModel === null || variant === null || !isOneOf(value.compatibility, ["pass", "fail", "unknown"] as const) || !isOneOf(value.conversationState, ["draft", "awaitingReply", "clarificationNeeded", "quoteReceived", "negotiating", "closed"] as const) || !isOneOf(value.provenance, ["controlled", "recorded", "live"] as const) || typeof value.ownerAuthoredTerms !== "boolean") return null;
  if (!isRecord(value.vendor)) return null;
  const vendorId = typeof value.vendor.id === "string" ? value.vendor.id : null;
  const vendorName = typeof value.vendor.name === "string" ? value.vendor.name : null;
  if (vendorId === null || vendorName === null) return null;
  const regions = stringArray(value.vendor.regions);
  const serviceCoverage = nullableString(value.vendor.serviceCoverage);
  const recommendationNote = nullableString(value.recommendationNote);
  if (regions === null || serviceCoverage === undefined || recommendationNote === undefined) return null;
  const quote = value.quote === null ? null : parseQuote(value.quote);
  if (value.quote !== null && quote === null) return null;
  if (!Array.isArray(value.evidence)) return null;
  const evidence: WorkbenchEvidence[] = [];
  for (const entry of value.evidence) {
    const parsed = parseEvidence(entry);
    if (parsed === null) return null;
    evidence.push(parsed);
  }
  return { id, requirementId, vendor: { id: vendorId, name: vendorName, regions, serviceCoverage }, productModel, variant, compatibility: value.compatibility, conversationState: value.conversationState, quote, evidence, provenance: value.provenance, ownerAuthoredTerms: value.ownerAuthoredTerms, recommendationNote };
}

function parseRequirement(value: unknown): WorkbenchRequirement | null {
  if (!isRecord(value)) return null;
  const id = typeof value.id === "string" ? value.id : null;
  const key = typeof value.key === "string" ? value.key : null;
  const title = typeof value.title === "string" ? value.title : null;
  const quantity = typeof value.quantity === "string" ? value.quantity : null;
  const unit = typeof value.unit === "string" ? value.unit : null;
  if (id === null || key === null || title === null || quantity === null || unit === null || !isOneOf(value.priority, ["P0", "P1", "P2"] as const) || !isOneOf(value.state, ["draft", "approved", "sourcing", "readyForDecision", "selected", "fulfilled", "cancelled"] as const) || !isOneOf(value.fulfillment, ["notOrdered", "ordered", "partiallyDelivered", "delivered", "installed", "commissioned", "cancelled"] as const) || !isFiniteNumber(value.version)) return null;
  const budgetMinorUnits = nullableNumber(value.budgetMinorUnits);
  const needByAt = nullableNumber(value.needByAt);
  if (budgetMinorUnits === undefined || needByAt === undefined) return null;
  return { id, key, title, quantity, unit, priority: value.priority, state: value.state, fulfillment: value.fulfillment, version: value.version, budgetMinorUnits, needByAt };
}

function parseJob(value: unknown): WorkbenchJob | null {
  if (!isRecord(value)) return null;
  const id = typeof value.id === "string" ? value.id : null;
  const summary = typeof value.summary === "string" ? value.summary : null;
  if (id === null || summary === null || !isOneOf(value.kind, ["research", "communication", "browser", "recovery"] as const) || !isOneOf(value.state, ["queued", "running", "completed", "cancelled", "failed", "paused", "waiting"] as const) || !isOneOf(value.delivery, ["queued", "sent", "delivered", "unknown", "partial", "paused"] as const) || !isFiniteNumber(value.attempts) || !isFiniteNumber(value.updatedAt)) return null;
  const progress = nullableNumber(value.progress);
  const failureCode = nullableString(value.failureCode);
  const lastCheckedAt = nullableNumber(value.lastCheckedAt);
  const evidenceIds = stringArray(value.evidenceIds);
  if (progress === undefined || failureCode === undefined || lastCheckedAt === undefined || evidenceIds === null) return null;
  if (progress !== null && (progress < 0 || progress > 1)) return null;
  return { id, kind: value.kind, state: value.state, delivery: value.delivery, progress, attempts: value.attempts, updatedAt: value.updatedAt, failureCode, lastCheckedAt, summary, evidenceIds };
}

function parseDecision(value: unknown): WorkbenchDecision | null {
  if (!isRecord(value)) return null;
  const id = typeof value.id === "string" ? value.id : null;
  const summary = typeof value.summary === "string" ? value.summary : null;
  if (id === null || summary === null || !isOneOf(value.type, ["selection", "approval", "recipient", "recovery", "risk"] as const) || !isOneOf(value.state, ["requested", "approved", "rejected", "invalidated", "resolved"] as const) || !isFiniteNumber(value.requestedAt) || typeof value.authorizationRequired !== "boolean") return null;
  const requirementId = nullableString(value.requirementId);
  const offerId = nullableString(value.offerId);
  const quoteId = nullableString(value.quoteId);
  const quoteVersion = nullableString(value.quoteVersion);
  const evidenceIds = stringArray(value.evidenceIds);
  if (requirementId === undefined || offerId === undefined || quoteId === undefined || quoteVersion === undefined || evidenceIds === null) return null;
  return { id, type: value.type, state: value.state, requirementId, offerId, quoteId, quoteVersion, requestedAt: value.requestedAt, evidenceIds, summary, authorizationRequired: value.authorizationRequired };
}

function parseActivityItem(value: unknown): WorkbenchActivityItem | null {
  if (!isRecord(value)) return null;
  const id = typeof value.id === "string" ? value.id : null;
  const type = typeof value.type === "string" ? value.type : null;
  const actorLabel = typeof value.actorLabel === "string" ? value.actorLabel : null;
  const summary = typeof value.summary === "string" ? value.summary : null;
  if (id === null || type === null || actorLabel === null || summary === null || !isFiniteNumber(value.occurredAt) || !isOneOf(value.state, ["recorded", "pending", "unknown", "failed"] as const)) return null;
  const evidenceIds = stringArray(value.evidenceIds);
  if (evidenceIds === null) return null;
  return { id, type, occurredAt: value.occurredAt, actorLabel, state: value.state, summary, evidenceIds };
}

/**
 * Runtime validation for the adapter boundary. Invalid or incomplete server
 * responses become an error state instead of being rendered as successful
 * purchasing facts.
 */
export function parseWorkbenchSnapshot(value: unknown, expectedProjectId?: string): WorkbenchSnapshot | null {
  if (!isRecord(value)) return null;
  const project = value.project;
  const access = value.access;
  const provenance = value.provenance;
  if (!isRecord(project) || !isRecord(access) || !isRecord(provenance)) return null;
  const projectId = typeof project.id === "string" ? project.id : null;
  const projectName = typeof project.name === "string" ? project.name : null;
  const projectRegion = typeof project.region === "string" ? project.region : null;
  const projectCurrency = typeof project.currency === "string" ? project.currency : null;
  if (projectId === null || projectName === null || projectRegion === null || projectCurrency === null) return null;
  if (expectedProjectId !== undefined && projectId !== expectedProjectId) return null;
  if (!isRecord(access.capabilities)) return null;
  const provenanceMode = typeof provenance.mode === "string" ? provenance.mode : null;
  const provenanceLabelValue = typeof provenance.label === "string" ? provenance.label : null;
  if (provenanceMode === null || provenanceLabelValue === null) return null;
  const requirements = value.requirements;
  const offers = value.offers;
  const jobs = value.jobs;
  const decisions = value.decisions;
  const activity = value.activity;
  if (!Array.isArray(requirements) || !Array.isArray(offers) || !Array.isArray(jobs) || !Array.isArray(decisions) || !isRecord(activity) || !Array.isArray(activity.items)) return null;
  const serialized = JSON.stringify(value);
  if (serialized === undefined || /"(?:[^"\\]*email[^"\\]*|[^"\\]*mailbox[^"\\]*|rawHeaders?|providerId|recipientAddress|secret)"\s*:/i.test(serialized)) return null;
  if (!isOneOf(access.role, ["viewer", "contributor", "approver", "owner"] as const)) return null;
  const capabilities = access.capabilities;
  if (!isRecord(capabilities) || typeof capabilities.canResearch !== "boolean" || typeof capabilities.canApprove !== "boolean" || typeof capabilities.canCommunicate !== "boolean" || typeof capabilities.canRecordOrder !== "boolean" || typeof capabilities.canResolveRisk !== "boolean") return null;
  const budgetMinorUnits = nullableNumber(project.budgetMinorUnits);
  const needByAt = nullableNumber(project.needByAt);
  if (budgetMinorUnits === undefined || needByAt === undefined) return null;
  if (!isOneOf(provenance.mode, ["controlled", "recorded", "live"] as const) || typeof provenance.ownerAuthoredTerms !== "boolean") return null;
  const projectValue: WorkbenchProject = { id: projectId, name: projectName, region: projectRegion, currency: projectCurrency, budgetMinorUnits, needByAt };
  const parsedRequirements: WorkbenchRequirement[] = [];
  const parsedOffers: WorkbenchOffer[] = [];
  const parsedJobs: WorkbenchJob[] = [];
  const parsedDecisions: WorkbenchDecision[] = [];
  const parsedActivity: WorkbenchActivityItem[] = [];
  for (const entry of requirements) { const parsed = parseRequirement(entry); if (parsed === null) return null; parsedRequirements.push(parsed); }
  for (const entry of offers) { const parsed = parseOffer(entry); if (parsed === null) return null; parsedOffers.push(parsed); }
  for (const entry of jobs) { const parsed = parseJob(entry); if (parsed === null) return null; parsedJobs.push(parsed); }
  for (const entry of decisions) { const parsed = parseDecision(entry); if (parsed === null) return null; parsedDecisions.push(parsed); }
  for (const entry of activity.items) { const parsed = parseActivityItem(entry); if (parsed === null) return null; parsedActivity.push(parsed); }
  const continueCursor = nullableString(activity.continueCursor);
  if (continueCursor === undefined || typeof activity.isDone !== "boolean") return null;
  const selectedOfferId = nullableString(value.selectedOfferId);
  const selectedForecastMinorUnits = nullableNumber(value.selectedForecastMinorUnits);
  if (selectedOfferId === undefined || selectedForecastMinorUnits === undefined || !isFiniteNumber(value.committedMinorUnits) || !isFiniteNumber(value.paidMinorUnits) || !isRecord(value.deliveredQuantityByRequirement)) return null;
  const deliveredQuantityByRequirement: Record<string, string> = {};
  for (const [key, quantity] of Object.entries(value.deliveredQuantityByRequirement)) { if (typeof quantity !== "string") return null; deliveredQuantityByRequirement[key] = quantity; }
  return {
    project: projectValue,
    access: { role: access.role, capabilities: { canResearch: capabilities.canResearch, canApprove: capabilities.canApprove, canCommunicate: capabilities.canCommunicate, canRecordOrder: capabilities.canRecordOrder, canResolveRisk: capabilities.canResolveRisk } },
    requirements: parsedRequirements,
    offers: parsedOffers,
    jobs: parsedJobs,
    decisions: parsedDecisions,
    activity: { items: parsedActivity, continueCursor, isDone: activity.isDone },
    provenance: { mode: provenance.mode, label: provenanceLabelValue, ownerAuthoredTerms: provenance.ownerAuthoredTerms },
    selectedOfferId,
    selectedForecastMinorUnits,
    committedMinorUnits: value.committedMinorUnits,
    paidMinorUnits: value.paidMinorUnits,
    deliveredQuantityByRequirement,
  };
}
