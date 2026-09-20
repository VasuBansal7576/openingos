/**
 * UI-owned boundary for the project-scoped purchasing projection.
 *
 * The browser never receives recipient addresses, raw message headers, or
 * provider credentials. The adapter accepts the exact redacted W1 result and
 * this module transforms it into the deliberately smaller view model.
 */

export type ProvenanceMode = "controlled" | "recorded" | "live" | "fixture" | "mixed" | "unknown";

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
  readonly canRecordEvidence: boolean;
  readonly canRecordQuote: boolean;
  readonly canCompare: boolean;
  readonly canCommunicate: boolean;
  readonly canClarify: boolean;
  readonly canApprove: boolean | null;
  readonly canRecordOrder: boolean | null;
  readonly canResolveRisk: boolean | null;
}

export interface WorkbenchProject {
  readonly id: string;
  readonly name: string;
  readonly region: string | null;
  readonly currency: string | null;
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
  readonly priority: string;
  readonly state: string;
  readonly fulfillment: string;
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
  readonly unit: string | null;
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
  readonly superseded: boolean | null;
}

export interface WorkbenchEvidence {
  readonly id: string;
  readonly label: string;
  readonly sourceKind: string;
  readonly freshness: string;
  readonly verification: string;
  readonly executionMode: ProvenanceMode;
  readonly counterpartyRole: string;
  readonly origin: "internal" | "ownerImport" | null;
  readonly sourceUrl: string | null;
}

export interface WorkbenchOffer {
  readonly id: string;
  readonly requirementId: string;
  readonly vendor: WorkbenchVendor | null;
  readonly productModel: string;
  readonly variant: string;
  readonly compatibility: Compatibility;
  readonly conversationState: string;
  readonly quote: WorkbenchQuote | null;
  readonly evidence: readonly WorkbenchEvidence[];
  readonly provenance: ProvenanceMode;
  readonly ownerAuthoredTerms: boolean;
  readonly recommendationNote: string | null;
}

export interface WorkbenchJob {
  readonly id: string;
  readonly kind: string;
  readonly state: string;
  readonly delivery: DeliveryState;
  readonly progress: number | null;
  readonly attempts: number;
  readonly updatedAt: number;
  readonly failureCode: string | null;
  readonly lastCheckedAt: number | null;
  readonly summary: string | null;
  readonly evidenceIds: readonly string[];
}

export interface WorkbenchDecision {
  readonly id: string;
  readonly type: string;
  readonly state: string;
  readonly requirementId: string | null;
  readonly offerId: string | null;
  readonly quoteId: string | null;
  readonly quoteVersion: string | null;
  readonly requestedAt: number;
  readonly evidenceIds: readonly string[];
  readonly summary: string | null;
  readonly authorizationRequired: boolean | null;
}

export interface WorkbenchActivityItem {
  readonly id: string;
  readonly type: string;
  readonly occurredAt: number;
  readonly actorLabel: string | null;
  readonly state: string;
  readonly summary: string | null;
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
  readonly committedMinorUnits: number | null;
  readonly paidMinorUnits: number | null;
  readonly deliveredQuantityByRequirement: Readonly<Record<string, string | null>>;
  readonly truncation: {
    readonly requirements: boolean;
    readonly offers: boolean;
    readonly jobs: boolean;
    readonly decisions: boolean;
  };
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
  readonly load: (projectId: string, cursor?: string | null) => Promise<unknown>;
  readonly subscribe?: (projectId: string, onSnapshot: (snapshot: unknown) => void, onError: (error: unknown) => void) => (() => void);
  readonly act: (action: WorkbenchAction) => Promise<WorkbenchActionResult>;
}

export function formatMoney(minorUnits: number | null, currency: string | null, unknownLabel = "Unknown"): string {
  if (minorUnits === null || !Number.isFinite(minorUnits) || currency === null || currency.trim().length === 0) return unknownLabel;
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
    case "fixture":
      return "Controlled fixture evidence";
    case "mixed":
      return "Mixed evidence provenance";
    case "unknown":
      return "Provenance unknown";
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
  if (value === undefined || value === null) return null;
  return isFiniteNumber(value) ? value : undefined;
}

function nullableString(value: unknown): string | null | undefined {
  if (value === undefined || value === null) return null;
  return typeof value === "string" ? value : undefined;
}

function requiredString(value: unknown): string | null {
  return typeof value === "string" && value.trim().length > 0 ? value : null;
}

function isOneOf<T extends string>(value: unknown, options: readonly T[]): value is T {
  return options.some((option) => option === value);
}

function stringArray(value: unknown): readonly string[] | null {
  if (!Array.isArray(value) || !value.every((entry) => typeof entry === "string")) return null;
  return value;
}

function parseProvenanceMode(value: unknown): ProvenanceMode | null {
  return isOneOf(value, ["controlled", "recorded", "live", "fixture", "mixed", "unknown"] as const) ? value : null;
}

function parseProjectionProvenance(value: unknown): WorkbenchProvenance | null {
  if (!isRecord(value)) return null;
  const mode = parseProvenanceMode(value.mode);
  const label = requiredString(value.label);
  if (mode === null || label === null || typeof value.ownerAuthoredTerms !== "boolean") return null;
  return { mode, label, ownerAuthoredTerms: value.ownerAuthoredTerms };
}

function parseMoney(value: unknown): { readonly currency: string; readonly minorUnits: number } | null {
  if (!isRecord(value)) return null;
  const currency = requiredString(value.currency);
  const minorUnits = value.minorUnits;
  if (currency === null || !isFiniteNumber(minorUnits) || !Number.isSafeInteger(minorUnits)) return null;
  return { currency, minorUnits };
}

function parseEvidence(value: unknown): WorkbenchEvidence | null {
  if (!isRecord(value)) return null;
  const id = requiredString(value.id);
  const field = requiredString(value.field);
  const sourceKind = requiredString(value.sourceKind);
  const sourceUrl = nullableString(value.sourceUrl);
  const executionMode = parseProvenanceMode(value.executionMode);
  const counterpartyRole = requiredString(value.counterpartyRole);
  if (id === null || field === null || sourceKind === null || sourceUrl === undefined || executionMode === null || counterpartyRole === null || !isFiniteNumber(value.capturedAt) || typeof value.verification !== "string" || typeof value.freshness !== "string") return null;
  if (sourceUrl !== null && !sourceUrl.startsWith("https://")) return null;
  const lastCheckedAt = nullableNumber(value.lastCheckedAt);
  if (lastCheckedAt === undefined) return null;
  return { id, label: field, sourceKind, freshness: value.freshness, verification: value.verification, executionMode, counterpartyRole, origin: null, sourceUrl };
}

function chargeScopeLabel(value: unknown): string | null {
  if (!isRecord(value) || !isOneOf(value.kind, ["quote", "line", "allocated"] as const)) return null;
  if (value.kind === "quote") return "quote";
  const lineId = requiredString(value.lineId);
  if (lineId === null) return null;
  if (value.kind === "line") return `line:${lineId}`;
  return isOneOf(value.method, ["fixed", "proportional"] as const) ? `allocated:${lineId}:${value.method}` : null;
}

function parseCharge(value: unknown, quoteCurrency: string): WorkbenchQuoteCharge | null {
  if (!isRecord(value)) return null;
  const kind = requiredString(value.label);
  const chargeId = requiredString(value.chargeId);
  const scope = chargeScopeLabel(value.scope);
  if (kind === null || chargeId === null || scope === null || !isRecord(value.state)) return null;
  const stateKind = value.state.kind;
  if (!isOneOf(stateKind, ["known", "included", "estimated", "unknown", "notApplicable"] as const)) return null;
  let minorUnits: number | null = null;
  let currency = quoteCurrency;
  if (stateKind === "known") {
    const amount = parseMoney(value.state.amount);
    if (amount === null || amount.currency !== quoteCurrency) return null;
    minorUnits = amount.minorUnits;
    currency = amount.currency;
  } else if (stateKind === "included") {
    if (requiredString(value.state.coveringId) === null) return null;
  } else if (stateKind === "estimated") {
    if (!isRecord(value.state.estimate) || !isOneOf(value.state.estimate.kind, ["point", "range"] as const)) return null;
    if (value.state.estimate.kind === "point") {
      const amount = parseMoney(value.state.estimate.amount);
      if (amount === null || amount.currency !== quoteCurrency) return null;
      minorUnits = amount.minorUnits;
      currency = amount.currency;
    } else {
      const minimum = parseMoney(value.state.estimate.minimum);
      const maximum = parseMoney(value.state.estimate.maximum);
      if (minimum === null || maximum === null || minimum.currency !== maximum.currency || minimum.currency !== quoteCurrency) return null;
      currency = minimum.currency;
    }
  } else if (stateKind === "unknown" || stateKind === "notApplicable") {
    if (requiredString(value.state.reason) === null) return null;
  }
  return { kind, state: stateKind, minorUnits, currency, scope, evidenceIds: [] };
}

function parseQuote(value: unknown): WorkbenchQuote | null {
  if (!isRecord(value)) return null;
  const id = requiredString(value.id);
  const version = requiredString(value.version);
  const currency = requiredString(value.currency);
  if (id === null || version === null || currency === null || !isFiniteNumber(value.createdAt) || !Array.isArray(value.lines) || !Array.isArray(value.charges) || !isRecord(value.taxBasis)) return null;
  if (!isOneOf(value.taxBasis.kind, ["inclusive", "exclusive", "unknown"] as const)) return null;
  const basisId = value.taxBasis.kind === "unknown" ? null : requiredString(value.taxBasis.basisId);
  const reason = value.taxBasis.kind === "unknown" ? requiredString(value.taxBasis.reason) : null;
  if (value.taxBasis.kind === "unknown" ? reason === null : basisId === null) return null;
  const lines: WorkbenchQuoteLine[] = [];
  for (const entry of value.lines) {
    if (!isRecord(entry)) return null;
    const lineId = requiredString(entry.lineId);
    const description = requiredString(entry.description);
    const quantity = requiredString(entry.quantity);
    const unitPrice = parseMoney(entry.unitPrice);
    if (lineId === null || description === null || quantity === null || unitPrice === null || unitPrice.currency !== currency) return null;
    lines.push({ lineId, description, quantity, unit: null, unitMinorUnits: unitPrice.minorUnits, evidenceIds: [] });
  }
  const charges: WorkbenchQuoteCharge[] = [];
  for (const entry of value.charges) {
    const parsed = parseCharge(entry, currency);
    if (parsed === null) return null;
    charges.push(parsed);
  }
  const provenance = parseProjectionProvenance(value.provenance);
  if (provenance === null) return null;
  return { id, version, currency, lines, charges, totalMinorUnits: null, comparableTotalMinorUnits: null, validUntil: null, taxBasis: value.taxBasis.kind, superseded: null };
}

function parseVendor(value: unknown): WorkbenchVendor | null {
  if (value === undefined) return null;
  if (!isRecord(value)) return null;
  const id = requiredString(value.id);
  const name = requiredString(value.name);
  const regions = stringArray(value.regions);
  const serviceCoverage = nullableString(value.serviceCoverage);
  if (id === null || name === null || regions === null || serviceCoverage === undefined) return null;
  return { id, name, regions, serviceCoverage };
}

function parseOffer(value: unknown): WorkbenchOffer | null {
  if (!isRecord(value)) return null;
  const id = requiredString(value.id);
  const requirementId = requiredString(value.requirementId);
  const productModel = requiredString(value.productModel);
  const variant = requiredString(value.variant);
  const compatibility = value.compatibility === "pass" ? "pass" : value.compatibility === "fail" ? "fail" : value.compatibility === "unknown" ? "unknown" : null;
  const conversationState = typeof value.conversationState === "string" ? value.conversationState : null;
  const vendor = parseVendor(value.vendor);
  const quote = value.latestValidQuote === null ? null : parseQuote(value.latestValidQuote);
  const evidence = Array.isArray(value.evidence) ? value.evidence.map(parseEvidence) : null;
  const provenance = parseProjectionProvenance(value.provenance);
  if (id === null || requirementId === null || productModel === null || variant === null || compatibility === null || conversationState === null || (vendor === null && value.vendor !== undefined) || (quote === null && value.latestValidQuote !== null) || evidence === null || evidence.some((entry) => entry === null) || provenance === null) return null;
  return { id, requirementId, vendor, productModel, variant, compatibility, conversationState, quote, evidence: evidence.filter((entry): entry is WorkbenchEvidence => entry !== null), provenance: provenance.mode, ownerAuthoredTerms: provenance.ownerAuthoredTerms, recommendationNote: null };
}

function parseRequirement(value: unknown): WorkbenchRequirement | null {
  if (!isRecord(value)) return null;
  const id = requiredString(value.id);
  const key = requiredString(value.key);
  const title = requiredString(value.title);
  const quantity = requiredString(value.quantity);
  const unit = requiredString(value.unit);
  const budgetMinorUnits = nullableNumber(value.budgetMinorUnits);
  const needByAt = nullableNumber(value.needByAt);
  if (id === null || key === null || title === null || quantity === null || unit === null || typeof value.priority !== "string" || typeof value.state !== "string" || typeof value.fulfillment !== "string" || !isFiniteNumber(value.version) || budgetMinorUnits === undefined || needByAt === undefined) return null;
  return { id, key, title, quantity, unit, priority: value.priority, state: value.state, fulfillment: value.fulfillment, version: value.version, budgetMinorUnits, needByAt };
}

function parseJob(value: unknown): WorkbenchJob | null {
  if (!isRecord(value)) return null;
  const id = requiredString(value.id);
  const kind = typeof value.kind === "string" ? value.kind : null;
  const status = isOneOf(value.status, ["queued", "sent", "delivered", "unknown", "partial", "paused"] as const) ? value.status : null;
  const attempts = Array.isArray(value.attempts) ? value.attempts : null;
  if (id === null || kind === null || status === null || !isFiniteNumber(value.createdAt) || !isFiniteNumber(value.updatedAt) || !isFiniteNumber(value.grantVersion) || attempts === null) return null;
  let lastCheckedAt: number | null = null;
  for (const attempt of attempts) {
    if (!isRecord(attempt) || typeof attempt.state !== "string" || !isFiniteNumber(attempt.createdAt)) return null;
    const observedAt = nullableNumber(attempt.observedAt);
    if (observedAt === undefined) return null;
    if (observedAt !== null && (lastCheckedAt === null || observedAt > lastCheckedAt)) lastCheckedAt = observedAt;
  }
  return { id, kind, state: "unknown", delivery: status, progress: null, attempts: attempts.length, updatedAt: value.updatedAt, failureCode: null, lastCheckedAt, summary: null, evidenceIds: [] };
}

function optionalId(value: unknown): string | null | undefined {
  if (value === undefined || value === null) return null;
  return requiredString(value) ?? undefined;
}

function parseDecision(value: unknown): WorkbenchDecision | null {
  if (!isRecord(value)) return null;
  const id = requiredString(value.id);
  const type = typeof value.kind === "string" ? value.kind : null;
  const state = typeof value.state === "string" ? value.state : null;
  const requirementId = optionalId(value.requirementId);
  const offerId = optionalId(value.candidateId);
  const quoteId = optionalId(value.quoteId);
  const quoteVersion = nullableString(value.quoteVersion);
  const decidedAt = nullableNumber(value.decidedAt);
  if (id === null || type === null || state === null || requirementId === undefined || offerId === undefined || quoteId === undefined || quoteVersion === undefined || decidedAt === undefined || !isFiniteNumber(value.createdAt)) return null;
  return { id, type, state, requirementId, offerId, quoteId, quoteVersion, requestedAt: value.createdAt, evidenceIds: [], summary: null, authorizationRequired: null };
}

function parseActivityItem(value: unknown): WorkbenchActivityItem | null {
  if (!isRecord(value)) return null;
  const id = requiredString(value.id);
  const type = typeof value.kind === "string" ? value.kind : null;
  if (id === null || type === null || !isFiniteNumber(value.createdAt)) return null;
  return { id, type, occurredAt: value.createdAt, actorLabel: null, state: "unknown", summary: null, evidenceIds: [] };
}

function parseProject(value: unknown): WorkbenchProject | null {
  if (!isRecord(value)) return null;
  const id = requiredString(value.id);
  const name = requiredString(value.name);
  const budgetMinorUnits = nullableNumber(value.budgetMinorUnits);
  const needByAt = nullableNumber(value.needByAt);
  if (id === null || name === null || !isOneOf(value.visibility, ["open", "restricted"] as const) || typeof value.organizationId !== "string" || !isFiniteNumber(value.createdAt) || budgetMinorUnits === undefined || needByAt === undefined) return null;
  let region: string | null = null;
  let locationCurrency: string | null = null;
  if (value.location !== undefined) {
    if (!isRecord(value.location)) return null;
    const locationRegion = requiredString(value.location.region);
    const reportingCurrency = requiredString(value.location.reportingCurrency);
    if (requiredString(value.location.id) === null || requiredString(value.location.name) === null || locationRegion === null || reportingCurrency === null || typeof value.location.operatingStatus !== "string") return null;
    region = locationRegion;
    locationCurrency = reportingCurrency;
  }
  const currency = nullableString(value.currency);
  if (currency === undefined) return null;
  return { id, name, region, currency: currency ?? locationCurrency, budgetMinorUnits, needByAt };
}

function parseAccess(value: unknown): WorkbenchAccess | null {
  if (!isRecord(value) || !isOneOf(value.effectiveRole, ["viewer", "contributor", "approver", "owner"] as const) || !isRecord(value.capabilities)) return null;
  const capabilities = value.capabilities;
  if (typeof capabilities.canResearch !== "boolean" || typeof capabilities.canRecordEvidence !== "boolean" || typeof capabilities.canRecordQuote !== "boolean" || typeof capabilities.canCompare !== "boolean" || typeof capabilities.canCommunicate !== "boolean" || typeof capabilities.canClarify !== "boolean") return null;
  return {
    role: value.effectiveRole,
    capabilities: {
      canResearch: capabilities.canResearch,
      canRecordEvidence: capabilities.canRecordEvidence,
      canRecordQuote: capabilities.canRecordQuote,
      canCompare: capabilities.canCompare,
      canCommunicate: capabilities.canCommunicate,
      canClarify: capabilities.canClarify,
      canApprove: null,
      canRecordOrder: null,
      canResolveRisk: null,
    },
  };
}

function containsPrivateProjectionKey(value: unknown): boolean {
  try {
    const serialized = JSON.stringify(value);
    return serialized === undefined || /"(?:[^"\\]*email[^"\\]*|[^"\\]*mailbox[^"\\]*|[^"\\]*rawHeaders?|providerId|recipientAddress|secret)"\s*:/i.test(serialized);
  } catch {
    return true;
  }
}

/**
 * Transform and validate the exact W1 `workbench/getProjection` result.
 * Unsupported aggregate facts remain null instead of being inferred from
 * candidate, quote, job, decision, or activity rows.
 */
export function parseWorkbenchSnapshot(value: unknown, expectedProjectId?: string): WorkbenchSnapshot | null {
  if (!isRecord(value) || value.ok !== true || containsPrivateProjectionKey(value)) return null;
  const project = parseProject(value.project);
  const access = parseAccess({ effectiveRole: value.effectiveRole, capabilities: value.capabilities });
  const provenance = parseProjectionProvenance(value.provenance);
  if (project === null || access === null || provenance === null || expectedProjectId !== undefined && project.id !== expectedProjectId) return null;
  if (!Array.isArray(value.requirements) || !Array.isArray(value.candidates) || !Array.isArray(value.jobs) || !Array.isArray(value.decisions)) return null;
  if (typeof value.requirementsTruncated !== "boolean" || typeof value.candidatesTruncated !== "boolean" || typeof value.jobsTruncated !== "boolean" || typeof value.decisionsTruncated !== "boolean") return null;
  if (!isRecord(value.activity) || !Array.isArray(value.activity.page) || typeof value.activity.isDone !== "boolean") return null;
  const continueCursor = nullableString(value.activity.continueCursor);
  if (continueCursor === undefined) return null;
  const requirements: WorkbenchRequirement[] = [];
  const offers: WorkbenchOffer[] = [];
  const jobs: WorkbenchJob[] = [];
  const decisions: WorkbenchDecision[] = [];
  const activity: WorkbenchActivityItem[] = [];
  for (const entry of value.requirements) { const parsed = parseRequirement(entry); if (parsed === null) return null; requirements.push(parsed); }
  for (const entry of value.candidates) { const parsed = parseOffer(entry); if (parsed === null) return null; offers.push(parsed); }
  for (const entry of value.jobs) { const parsed = parseJob(entry); if (parsed === null) return null; jobs.push(parsed); }
  for (const entry of value.decisions) { const parsed = parseDecision(entry); if (parsed === null) return null; decisions.push(parsed); }
  for (const entry of value.activity.page) { const parsed = parseActivityItem(entry); if (parsed === null) return null; activity.push(parsed); }
  return {
    project,
    access,
    requirements,
    offers,
    jobs,
    decisions,
    activity: { items: activity, continueCursor, isDone: value.activity.isDone },
    provenance,
    selectedOfferId: null,
    selectedForecastMinorUnits: null,
    committedMinorUnits: null,
    paidMinorUnits: null,
    deliveredQuantityByRequirement: {},
    truncation: { requirements: value.requirementsTruncated, offers: value.candidatesTruncated, jobs: value.jobsTruncated, decisions: value.decisionsTruncated },
  };
}
