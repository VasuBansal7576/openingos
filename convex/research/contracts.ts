/**
 * R1 research contracts.
 *
 * Firecrawl responses are untrusted provider data.  This module keeps the
 * boundary narrow and deterministic before anything reaches the shared F1
 * records.  It intentionally does not expose Firecrawl's arbitrary `extra`
 * options or persist a raw provider response as an application record.
 */

import { v } from "convex/values";
import { canonicalJson, payloadHash } from "../shared/hashing.js";

export const researchModeValidator = v.union(
  v.literal("search"),
  v.literal("scrape"),
  v.literal("map"),
);

export type ResearchMode = "search" | "scrape" | "map";

export const researchExecutionModeValidator = v.union(
  v.literal("live"),
  v.literal("recorded"),
  v.literal("fixture"),
);

export type ResearchExecutionMode = "live" | "recorded" | "fixture";

export const researchCompletenessValidator = v.union(
  v.literal("complete"),
  v.literal("partial"),
  v.literal("unavailable"),
);

export type ResearchCompleteness = "complete" | "partial" | "unavailable";

export const researchFreshnessValidator = v.union(
  v.literal("fresh"),
  v.literal("stale"),
  v.literal("expired"),
  v.literal("unknown"),
);

export type ResearchFreshness = "fresh" | "stale" | "expired" | "unknown";

export const researchVerificationValidator = v.union(
  v.literal("unverified"),
  v.literal("verified"),
  v.literal("conflicted"),
  v.literal("superseded"),
);

export type ResearchVerification = "unverified" | "verified" | "conflicted" | "superseded";

export const researchIntentValidator = v.object({
  query: v.string(),
  mode: v.optional(researchModeValidator),
  sourceUrl: v.optional(v.string()),
});

export interface ResearchIntent {
  readonly query: string;
  readonly mode?: ResearchMode;
  readonly sourceUrl?: string;
}

export const researchClaimValidator = v.object({
  field: v.string(),
  originalValue: v.string(),
  normalizedValue: v.string(),
  locator: v.optional(v.string()),
  verification: researchVerificationValidator,
  freshness: researchFreshnessValidator,
});

export interface ResearchClaim {
  readonly field: string;
  readonly originalValue: string;
  readonly normalizedValue: string;
  readonly locator?: string;
  readonly verification: ResearchVerification;
  readonly freshness: ResearchFreshness;
}

export const normalizedSourceRecordValidator = v.object({
  sourceUrl: v.optional(v.string()),
  title: v.optional(v.string()),
  vendorName: v.optional(v.string()),
  productModel: v.optional(v.string()),
  variant: v.optional(v.string()),
  variantKey: v.optional(v.string()),
  providerId: v.optional(v.string()),
  capturedAt: v.number(),
  contentHash: v.string(),
  completeness: researchCompletenessValidator,
  missingFields: v.array(v.string()),
  truncated: v.boolean(),
  unstoredPages: v.number(),
  claims: v.array(researchClaimValidator),
  counterpartyRole: v.literal("vendor"),
  executionMode: researchExecutionModeValidator,
});

export interface NormalizedSourceRecord {
  readonly sourceUrl?: string;
  readonly title?: string;
  readonly vendorName?: string;
  readonly productModel?: string;
  readonly variant?: string;
  readonly variantKey?: string;
  readonly providerId?: string;
  readonly capturedAt: number;
  readonly contentHash: string;
  readonly completeness: ResearchCompleteness;
  readonly missingFields: string[];
  readonly truncated: boolean;
  readonly unstoredPages: number;
  readonly claims: ResearchClaim[];
  readonly counterpartyRole: "vendor";
  readonly executionMode: ResearchExecutionMode;
}

export const providerOutcomeValidator = v.object({
  mode: researchModeValidator,
  records: v.array(normalizedSourceRecordValidator),
  capturedAt: v.number(),
  requestCount: v.number(),
  incompleteCount: v.number(),
  provider: v.literal("firecrawl"),
  controlled: v.boolean(),
});

export interface ProviderOutcome {
  readonly mode: ResearchMode;
  readonly records: NormalizedSourceRecord[];
  readonly capturedAt: number;
  readonly requestCount: number;
  readonly incompleteCount: number;
  readonly provider: "firecrawl";
  readonly controlled: boolean;
}

export const researchResultValidator = v.union(
  v.object({
    ok: v.literal(true),
    jobId: v.id("jobs"),
    operationId: v.id("operations"),
    state: v.string(),
    requestCount: v.number(),
    incompleteCount: v.number(),
    controlled: v.boolean(),
  }),
  v.object({
    ok: v.literal(true),
    jobId: v.id("jobs"),
    operationId: v.null(),
    state: v.string(),
    requestCount: v.number(),
    incompleteCount: v.number(),
    controlled: v.boolean(),
    recovery: v.string(),
  }),
  v.object({ ok: v.literal(false), code: v.string(), message: v.string() }),
);

export const researchEvidenceViewValidator = v.object({
  id: v.id("evidence"),
  projectId: v.id("projects"),
  sourceKind: v.string(),
  sourceUrl: v.optional(v.string()),
  providerIds: v.optional(v.string()),
  capturedAt: v.number(),
  contentHash: v.string(),
  completeness: researchCompletenessValidator,
  counterpartyRole: v.string(),
  executionMode: researchExecutionModeValidator,
  locator: v.optional(v.string()),
});

export const researchClaimViewValidator = v.object({
  id: v.id("productEvidence"),
  requirementId: v.optional(v.id("requirements")),
  candidateId: v.optional(v.id("candidates")),
  field: v.string(),
  sourceKind: v.string(),
  sourceUrl: v.optional(v.string()),
  capturedAt: v.number(),
  originalValue: v.string(),
  normalizedValue: v.string(),
  verification: researchVerificationValidator,
  freshness: researchFreshnessValidator,
  lastCheckedAt: v.optional(v.number()),
  counterpartyRole: v.union(v.literal("ownerStandIn"), v.literal("vendor")),
  executionMode: researchExecutionModeValidator,
  origin: v.union(v.literal("internal"), v.literal("ownerImport")),
});

export const researchCandidateViewValidator = v.object({
  id: v.id("candidates"),
  requirementId: v.id("requirements"),
  vendorId: v.id("vendors"),
  productModel: v.string(),
  variant: v.string(),
  variantKey: v.string(),
  compatibility: v.union(v.literal("pass"), v.literal("fail"), v.literal("unknown")),
  conversationState: v.string(),
  createdAt: v.number(),
});

/**
 * Pagination metadata for one independently paged research stream.
 *
 * `continueCursor` is scoped to the exact stream query that produced it.  A
 * caller must not reuse an evidence cursor for claims or candidates.
 */
export const researchPaginationInfoValidator = v.object({
  continueCursor: v.union(v.string(), v.null()),
  isDone: v.boolean(),
  splitCursor: v.optional(v.union(v.string(), v.null())),
  pageStatus: v.optional(
    v.union(
      v.literal("SplitRecommended"),
      v.literal("SplitRequired"),
      v.null(),
    ),
  ),
});

export const researchEvidenceProgressValidator = v.object({
  returned: v.number(),
  complete: v.number(),
  partial: v.number(),
  unavailable: v.number(),
});

export const researchStreamProgressValidator = v.object({
  returned: v.number(),
});

export const projectResearchEvidencePageValidator = v.object({
  ok: v.literal(true),
  projectId: v.id("projects"),
  evidence: v.array(researchEvidenceViewValidator),
  pagination: researchPaginationInfoValidator,
  progress: researchEvidenceProgressValidator,
});

export const projectResearchClaimsPageValidator = v.object({
  ok: v.literal(true),
  projectId: v.id("projects"),
  claims: v.array(researchClaimViewValidator),
  pagination: researchPaginationInfoValidator,
  progress: researchStreamProgressValidator,
});

export const projectResearchCandidatesPageValidator = v.object({
  ok: v.literal(true),
  projectId: v.id("projects"),
  candidates: v.array(researchCandidateViewValidator),
  pagination: researchPaginationInfoValidator,
  progress: researchStreamProgressValidator,
});

export const projectResearchResultValidator = v.object({
  ok: v.literal(true),
  projectId: v.id("projects"),
  evidence: v.array(researchEvidenceViewValidator),
  claims: v.array(researchClaimViewValidator),
  candidates: v.array(researchCandidateViewValidator),
  pagination: v.object({
    evidence: researchPaginationInfoValidator,
    claims: researchPaginationInfoValidator,
    candidates: researchPaginationInfoValidator,
  }),
  continueCursor: v.union(v.string(), v.null()),
  isDone: v.boolean(),
  progress: v.object({
    sources: v.number(),
    complete: v.number(),
    partial: v.number(),
    unavailable: v.number(),
    claims: v.number(),
    candidates: v.number(),
  }),
  streamProgress: v.object({
    evidence: researchEvidenceProgressValidator,
    claims: researchStreamProgressValidator,
    candidates: researchStreamProgressValidator,
  }),
});

export const compareResultValidator = v.union(
  v.object({
    ok: v.literal(true),
    projectId: v.id("projects"),
    candidates: v.array(researchCandidateViewValidator),
    claims: v.array(researchClaimViewValidator),
    unknownFields: v.array(v.string()),
  }),
  v.object({ ok: v.literal(false), code: v.string(), message: v.string() }),
);

export const researchRecoveryResultValidator = v.union(
  v.object({ ok: v.literal(true), jobId: v.id("jobs"), operationId: v.id("operations"), state: v.string() }),
  v.object({ ok: v.literal(false), code: v.string(), message: v.string() }),
);

export interface NormalizeProviderInput {
  readonly mode: ResearchMode;
  readonly response: unknown;
  readonly capturedAt: number;
  readonly sourceUrl?: string;
  readonly executionMode: ResearchExecutionMode;
}

const MAX_CAPTURE_BYTES = 200_000;
const REQUIRED_PRODUCT_FIELDS = [
  "model",
  "variant",
  "price",
  "currency",
  "availability",
  "delivery",
  "serviceCoverage",
] as const;

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function readString(value: unknown): string | undefined {
  if (typeof value !== "string") return undefined;
  const normalized = value.trim();
  return normalized.length === 0 ? undefined : normalized;
}

function readNumber(value: unknown): number | undefined {
  return typeof value === "number" && Number.isFinite(value) ? value : undefined;
}

function stringValue(value: unknown): string | undefined {
  const direct = readString(value);
  if (direct !== undefined) return direct;
  if (typeof value === "number" || typeof value === "boolean") return String(value);
  if (value === null) return "null";
  if (isRecord(value) || Array.isArray(value)) {
    try {
      return canonicalJson(value);
    } catch {
      return undefined;
    }
  }
  return undefined;
}

function safeHash(value: unknown): string {
  try {
    return payloadHash(value);
  } catch {
    return payloadHash(String(value));
  }
}

function byteLength(value: string): number {
  return new TextEncoder().encode(value).byteLength;
}

function boundedText(value: string): { readonly value: string; readonly truncated: boolean } {
  if (byteLength(value) <= MAX_CAPTURE_BYTES) return { value, truncated: false };
  let end = value.length;
  while (end > 0 && byteLength(value.slice(0, end)) > MAX_CAPTURE_BYTES) end -= Math.max(1, Math.ceil(end / 20));
  return { value: value.slice(0, end), truncated: true };
}

function sourceUrlOf(item: Record<string, unknown>, fallback: string | undefined): string | undefined {
  const metadata = isRecord(item.metadata) ? item.metadata : undefined;
  return (
    readString(item.url) ??
    readString(item.sourceURL) ??
    readString(metadata?.url) ??
    readString(metadata?.sourceURL) ??
    fallback
  );
}

function hostNameOf(sourceUrl: string | undefined): string | undefined {
  if (sourceUrl === undefined) return undefined;
  try {
    return new URL(sourceUrl).hostname.replace(/^www\./i, "");
  } catch {
    return undefined;
  }
}

function variantKeyFor(model: string | undefined, variant: string | undefined, sourceUrl: string | undefined): string | undefined {
  if (model === undefined && variant === undefined) return undefined;
  const base = `${(model ?? "unknown-model").toLocaleLowerCase()}|${(variant ?? "unknown-variant").toLocaleLowerCase()}`;
  return base.replace(/\s+/g, " ").trim() || sourceUrl;
}

function freshnessFor(capturedAt: number): ResearchFreshness {
  if (!Number.isFinite(capturedAt) || capturedAt <= 0) return "unknown";
  return Date.now() - capturedAt <= 24 * 60 * 60 * 1000 ? "fresh" : "stale";
}

function claim(
  field: string,
  value: unknown,
  locator: string,
  freshness: ResearchFreshness,
): ResearchClaim | undefined {
  const text = stringValue(value);
  if (text === undefined) return undefined;
  return {
    field,
    originalValue: text,
    normalizedValue: text,
    locator,
    verification: "unverified",
    freshness,
  };
}

function mapProduct(
  item: Record<string, unknown>,
  input: NormalizeProviderInput,
  forcedUrl?: string,
): NormalizedSourceRecord {
  const sourceUrl = sourceUrlOf(item, forcedUrl ?? input.sourceUrl);
  const metadata = isRecord(item.metadata) ? item.metadata : undefined;
  const extracted = isRecord(item.json) ? item.json : undefined;
  const model =
    readString(extracted?.productModel) ??
    readString(extracted?.model) ??
    readString(extracted?.manufacturerModel) ??
    readString(item.productModel) ??
    readString(item.model);
  const variant =
    readString(extracted?.variant) ??
    readString(extracted?.variantName) ??
    readString(item.variant);
  const title = readString(extracted?.title) ?? readString(item.title) ?? readString(metadata?.title);
  const vendorName =
    readString(extracted?.vendorName) ??
    readString(extracted?.vendor) ??
    readString(item.vendorName) ??
    hostNameOf(sourceUrl);
  const freshness = freshnessFor(input.capturedAt);
  const claims: ResearchClaim[] = [];
  const addClaim = (field: string, value: unknown, locator: string): void => {
    const next = claim(field, value, locator, freshness);
    if (next !== undefined && !claims.some((existing) => existing.field === field)) claims.push(next);
  };
  addClaim("title", title, "metadata.title");
  addClaim("model", model, "json.model");
  addClaim("variant", variant, "json.variant");
  addClaim("vendor", vendorName, "json.vendor");
  for (const [field, keys] of Object.entries({
    price: ["price", "amount"],
    currency: ["currency", "priceCurrency"],
    availability: ["availability", "stock", "inventory"],
    delivery: ["delivery", "leadTime", "deliveryTime"],
    serviceCoverage: ["serviceCoverage", "service", "support"],
    warranty: ["warranty", "warrantyTerms"],
    dimensions: ["dimensions", "dimension"],
  })) {
    for (const key of keys) {
      const value = extracted?.[key] ?? item[key];
      if (value !== undefined) {
        addClaim(field, value, `json.${key}`);
        break;
      }
    }
  }
  const missingFields: string[] = REQUIRED_PRODUCT_FIELDS.filter((field) => {
    const aliases: Record<string, string[]> = {
      model: ["model"],
      variant: ["variant"],
      price: ["price"],
      currency: ["currency"],
      availability: ["availability"],
      delivery: ["delivery"],
      serviceCoverage: ["serviceCoverage"],
    };
    return !claims.some((entry) => aliases[field]?.includes(entry.field));
  });
  const rawText =
    stringValue(item.markdown) ??
    stringValue(item.html) ??
    stringValue(item.description) ??
    canonicalJson(item);
  const bounded = boundedText(rawText ?? "");
  const topLevelTruncated = item.truncated === true || bounded.truncated;
  const unstored = Math.max(
    0,
    readNumber(item.unstored) ??
      readNumber(item.unstoredPages) ??
      readNumber(item.pagesNotStored) ??
      (item.stored === false ? 1 : 0),
  );
  const providerId = readString(item.id);
  const hasJson = input.mode !== "scrape" || extracted !== undefined;
  if (input.mode === "scrape" && !hasJson && !missingFields.includes("extracted-json")) {
    missingFields.push("extracted-json");
  }
  if (unstored > 0 && !missingFields.includes("unstored-pages")) missingFields.push("unstored-pages");
  const incomplete = topLevelTruncated || missingFields.length > 0;
  const variantKey = variantKeyFor(model, variant, sourceUrl);
  return {
    ...(sourceUrl === undefined ? {} : { sourceUrl }),
    ...(title === undefined ? {} : { title }),
    ...(vendorName === undefined ? {} : { vendorName }),
    ...(model === undefined ? {} : { productModel: model }),
    ...(variant === undefined ? {} : { variant }),
    ...(variantKey === undefined ? {} : { variantKey }),
    ...(providerId === undefined ? {} : { providerId }),
    capturedAt: input.capturedAt,
    contentHash: safeHash({ sourceUrl, content: bounded.value }),
    completeness: incomplete ? "partial" : "complete",
    missingFields,
    truncated: topLevelTruncated,
    unstoredPages: unstored,
    claims,
    counterpartyRole: "vendor",
    executionMode: input.executionMode,
  };
}

function asItems(response: unknown, mode: ResearchMode): Record<string, unknown>[] {
  if (!isRecord(response)) return [];
  if (mode === "scrape") return [response];
  if (mode === "map") {
    const links = Array.isArray(response.links) ? response.links : [];
    return links.filter(isRecord).map((link) => ({ ...link }));
  }
  const arrays = [response.web, response.news, response.images, response.developer];
  return arrays.flatMap((entry) => (Array.isArray(entry) ? entry.filter(isRecord) : []));
}

/** Normalize one bounded provider response without asserting unsupported facts. */
export function normalizeProviderResponse(input: NormalizeProviderInput): ProviderOutcome {
  const capturedAt = Number.isFinite(input.capturedAt) ? input.capturedAt : Date.now();
  const records = asItems(input.response, input.mode).map((item) =>
    mapProduct(item, { ...input, capturedAt }, input.mode === "map" ? readString(item.url) : undefined),
  );
  const incompleteCount = records.filter((record) => record.completeness !== "complete").length;
  return {
    mode: input.mode,
    records,
    capturedAt,
    requestCount: 1,
    incompleteCount,
    provider: "firecrawl",
    controlled: input.executionMode !== "live",
  };
}

/** A bounded public URL guard used immediately before map/scrape dispatch. */
export function isSafePublicSourceUrl(value: string): boolean {
  try {
    const parsed = new URL(value);
    if (parsed.protocol !== "https:" && parsed.protocol !== "http:") return false;
    const host = parsed.hostname.toLocaleLowerCase();
    if (host === "localhost" || host.endsWith(".localhost") || host === "127.0.0.1" || host === "::1") return false;
    if (/^(10|127)\./.test(host) || /^192\.168\./.test(host) || /^169\.254\./.test(host)) return false;
    if (/^172\.(1[6-9]|2\d|3[0-1])\./.test(host)) return false;
    return parsed.username.length === 0 && parsed.password.length === 0;
  } catch {
    return false;
  }
}

/** Provider errors are parsed from unknown without exposing response bodies. */
export interface FirecrawlErrorInfo {
  readonly status: number | null;
  readonly code: "credits" | "transient" | "invalid" | "unknown";
  readonly message: string;
  readonly unknownCharges: boolean;
}

export function classifyFirecrawlError(error: unknown): FirecrawlErrorInfo {
  let status: number | null = null;
  let message = "Firecrawl collection failed";
  if (error instanceof Error) message = error.message;
  if (isRecord(error)) {
    const data = isRecord(error.data) ? error.data : error;
    const possibleStatus = data.status;
    status = typeof possibleStatus === "number" && Number.isFinite(possibleStatus) ? possibleStatus : null;
    const possibleMessage = data.message;
    if (typeof possibleMessage === "string" && possibleMessage.length > 0) message = possibleMessage.slice(0, 300);
  }
  const lower = message.toLocaleLowerCase();
  const credits = status === 402 || /credit|quota|allowance|insufficient.?balance|payment required/.test(lower);
  const transient = status === null || status === 0 || [408, 425, 429, 500, 502, 503, 504].includes(status);
  return {
    status,
    code: credits ? "credits" : transient ? "transient" : status !== null ? "invalid" : "unknown",
    message,
    unknownCharges: !credits && transient,
  };
}
