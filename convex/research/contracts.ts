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

/**
 * Bounded public-source URL guard, enforced immediately before map/scrape
 * dispatch (request validation and the pre-claim execute check in
 * `collection.ts`).
 *
 * Literal-address policy: every IPv4/IPv6 literal host is classified below.
 * Only globally routable unicast literals pass. Loopback, unspecified,
 * private, link-local, multicast, reserved, documentation, benchmark, TEST-NET
 * and CGNAT ranges are rejected, including when reached through an IPv6
 * transition form (IPv4-mapped, 6to4, NAT64 well-known prefix) whose embedded
 * IPv4 address falls in one of those ranges.
 *
 * DNS policy (honest limitation, not a guarantee): DNS names are allowed
 * without resolution. This guard performs no DNS lookup, offers no
 * DNS-rebinding protection, and maintains no allowlist. A name that resolves
 * to a blocked literal at fetch time is not stopped here.
 *
 * Redirect policy (honest limitation, not a guarantee): the Firecrawl
 * provider transport may follow HTTP redirects inside its own bounded attempt
 * budget. Redirect targets are provider-observed and recorded on the evidence
 * rows, but they are not re-validated by this guard.
 */
export function isSafePublicSourceUrl(value: string): boolean {
  let parsed: URL;
  try {
    parsed = new URL(value);
  } catch {
    return false;
  }
  if (parsed.protocol !== "https:" && parsed.protocol !== "http:") return false;
  if (parsed.username.length > 0 || parsed.password.length > 0) return false;
  return isPublicSourceHost(parsed.hostname);
}

function isPublicSourceHost(hostname: string): boolean {
  let host = hostname.toLocaleLowerCase();
  // WHATWG URL keeps brackets on `hostname` for IPv6 literals (`[::1]`).
  // Strip one bracket pair so the literal classifier below sees the address.
  if (host.startsWith("[") && host.endsWith("]") && host.length >= 2) {
    host = host.slice(1, -1);
  }
  if (host.length === 0) return false;
  if (host.includes(":")) return isPublicIpv6Literal(host);
  if (isDecimalDottedQuad(host)) return isPublicIpv4(host.split(".").map(Number));
  // A DNS name. `localhost` and its subdomains never leave the device.
  // Anything else is allowed here without resolution; see the DNS policy above.
  if (host === "localhost" || host.endsWith(".localhost")) return false;
  return true;
}

/**
 * WHATWG URL normalizes non-standard IPv4 spellings (hex/octal parts and
 * single-number forms such as `http://2130706433/`) to decimal dotted quads
 * in `hostname`, so classifying the normalized quad also covers those forms.
 */
function isDecimalDottedQuad(host: string): boolean {
  return /^\d{1,3}\.\d{1,3}\.\d{1,3}\.\d{1,3}$/.test(host);
}

function isPublicIpv4(octets: number[]): boolean {
  if (octets.length !== 4 || octets.some((part) => !Number.isInteger(part) || part < 0 || part > 255)) {
    return false;
  }
  const [a, b, c] = octets as [number, number, number, number];
  if (a === 0) return false; // 0.0.0.0/8: unspecified and "this host".
  if (a === 10) return false; // RFC 1918 private.
  if (a === 127) return false; // Loopback.
  if (a === 169 && b === 254) return false; // Link-local.
  if (a === 172 && b >= 16 && b <= 31) return false; // RFC 1918 private.
  if (a === 192 && b === 168) return false; // RFC 1918 private.
  if (a === 100 && (b & 0xc0) === 0x40) return false; // CGNAT 100.64.0.0/10.
  if (a === 192 && b === 0 && c === 2) return false; // TEST-NET-1.
  if (a === 198 && b === 51 && c === 100) return false; // TEST-NET-2.
  if (a === 203 && b === 0 && c === 113) return false; // TEST-NET-3.
  if (a === 198 && (b === 18 || b === 19)) return false; // Benchmark 198.18.0.0/15.
  if (a === 192 && b === 88 && c === 99) return false; // Deprecated 6to4 relay anycast.
  if (a >= 224 && a <= 239) return false; // Multicast.
  if (a >= 240) return false; // Reserved, including 255.255.255.255.
  return true;
}

function parseIpv6Literal(text: string): Uint8Array | null {
  // A zone id (`fe80::1%eth0`) never identifies a distinct public host; the
  // scoped form is link-local by definition, so reject it outright.
  if (text.includes("%")) return null;
  const halves = text.split("::");
  if (halves.length > 2) return null;
  const head = halves[0] === "" || halves[0] === undefined ? [] : halves[0].split(":");
  const tail = halves.length === 2 && halves[1] !== "" && halves[1] !== undefined ? halves[1].split(":") : [];
  const expandTail = (parts: string[]): number[] | null => {
    const out: number[] = [];
    for (const part of parts) {
      if (part.includes(".")) {
        const bytes = parseDottedQuadBytes(part);
        if (bytes === null) return null;
        out.push((bytes[0] << 8) | bytes[1], (bytes[2] << 8) | bytes[3]);
        continue;
      }
      if (!/^[0-9a-f]{1,4}$/.test(part)) return null;
      out.push(parseInt(part, 16));
    }
    return out;
  };
  const headGroups = expandTail(head);
  const tailGroups = expandTail(tail);
  if (headGroups === null || tailGroups === null) return null;
  // An embedded dotted quad must be the final 32 bits of the address.
  const embeddedInHead = head.some((part) => part.includes("."));
  if (embeddedInHead && halves.length === 2) return null;
  if (halves.length === 1 && headGroups.length !== 8) return null;
  if (halves.length === 2 && headGroups.length + tailGroups.length > 8) return null;
  const groups = halves.length === 1
    ? headGroups
    : [...headGroups, ...new Array(8 - headGroups.length - tailGroups.length).fill(0), ...tailGroups];
  if (groups.length !== 8) return null;
  const bytes = new Uint8Array(16);
  groups.forEach((group, index) => {
    bytes[index * 2] = (group >> 8) & 0xff;
    bytes[index * 2 + 1] = group & 0xff;
  });
  return bytes;
}

function parseDottedQuadBytes(text: string): [number, number, number, number] | null {
  const parts = text.split(".");
  if (parts.length !== 4) return null;
  const octets: number[] = [];
  for (const part of parts) {
    if (!/^\d{1,3}$/.test(part)) return null;
    const value = Number(part);
    if (!Number.isInteger(value) || value < 0 || value > 255) return null;
    octets.push(value);
  }
  return octets as [number, number, number, number];
}

function isPublicIpv6Literal(host: string): boolean {
  const parsed = parseIpv6Literal(host);
  if (parsed === null) return false;
  // The parser always returns exactly 16 bytes; an absent index fails closed
  // to zero, which can only make the checks below more restrictive.
  const at = (index: number): number => parsed[index] ?? 0;
  const isZeroRange = (start: number, end: number): boolean => {
    for (let index = start; index < end; index += 1) {
      if (at(index) !== 0) return false;
    }
    return true;
  };
  // ::ffff:0:0/96 IPv4-mapped: classify the embedded IPv4 address, so mapped
  // loopback/private/CGNAT forms are rejected with their IPv4 meaning.
  const isMapped = isZeroRange(0, 10) && at(10) === 0xff && at(11) === 0xff;
  if (isMapped) {
    return isPublicIpv4([at(12), at(13), at(14), at(15)]);
  }
  // 2002::/16 6to4: bytes 2-5 carry the embedded IPv4 address.
  if (at(0) === 0x20 && at(1) === 0x02) {
    return isPublicIpv4([at(2), at(3), at(4), at(5)]);
  }
  // 64:ff9b::/96 well-known NAT64 prefix: last 32 bits carry the IPv4 address.
  if (
    at(0) === 0x00 && at(1) === 0x64 && at(2) === 0xff && at(3) === 0x9b &&
    isZeroRange(4, 12)
  ) {
    return isPublicIpv4([at(12), at(13), at(14), at(15)]);
  }
  if (isZeroRange(0, 16)) return false; // :: unspecified.
  if (isZeroRange(0, 15) && at(15) === 0x01) return false; // ::1 loopback.
  if (at(0) === 0xff) return false; // ff00::/8 multicast.
  if (at(0) === 0xfe && (at(1) & 0xc0) === 0x80) return false; // fe80::/10 link-local.
  if ((at(0) & 0xfe) === 0xfc) return false; // fc00::/7 unique-local.
  if (at(0) === 0x01 && at(1) === 0x00 && isZeroRange(2, 8)) return false; // 100::/64 discard.
  if (at(0) === 0x20 && at(1) === 0x01 && at(2) === 0x0d && at(3) === 0xb8) return false; // 2001:db8::/32 documentation.
  return true;
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
