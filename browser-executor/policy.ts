// Destination policy and observed-target freshness.
//
// Model output never becomes a navigation destination unchecked: every URL
// (including every redirect hop) must be https, outside private/reserved
// network ranges and cloud metadata endpoints, and inside the job's allowed
// origins. Interaction targets must originate in the current observed DOM
// state: unknown target IDs (arbitrary selector strings), stale document
// versions, and occluded targets are all denied.

import type { Decision, ObservedTarget } from "./types.ts";
import { approved, denied } from "./types.ts";

const MAX_REDIRECT_HOPS = 5;

function parseIpv4(host: string): number | undefined {
  const parts = host.split(".");
  if (parts.length !== 4) {
    return undefined;
  }
  let value = 0;
  for (const part of parts) {
    if (part.length === 0 || part.length > 3) {
      return undefined;
    }
    if (!/^[0-9]+$/.test(part)) {
      return undefined;
    }
    const octet = Number(part);
    if (!Number.isInteger(octet) || octet < 0 || octet > 255) {
      return undefined;
    }
    if (part.length > 1 && part.startsWith("0")) {
      return undefined;
    }
    value = value * 256 + octet;
  }
  return value >>> 0;
}

function inRange(address: number, base: number, bits: number): boolean {
  const shift = 32 - bits;
  return (address >>> shift) === (base >>> shift);
}

const IPV4_LOOPBACK = 0x7f000000;
const IPV4_PRIVATE_10 = 0x0a000000;
const IPV4_PRIVATE_172 = 0xac100000;
const IPV4_LINK_LOCAL = 0xa9fe0000;
const IPV4_THIS_NETWORK = 0x00000000;
const IPV4_CGNAT = 0x64400000;

function ipv4Verdict(address: number): "ok" | "private-network" | "metadata-endpoint" {
  if (inRange(address, IPV4_THIS_NETWORK, 8)) {
    return "private-network";
  }
  if (inRange(address, IPV4_LOOPBACK, 8)) {
    return "private-network";
  }
  if (inRange(address, IPV4_PRIVATE_10, 8)) {
    return "private-network";
  }
  if (inRange(address, IPV4_PRIVATE_172, 12)) {
    return "private-network";
  }
  if (inRange(address, 0xc0a80000, 16)) {
    return "private-network";
  }
  if (inRange(address, IPV4_CGNAT, 10)) {
    return "private-network";
  }
  if (inRange(address, IPV4_LINK_LOCAL, 16)) {
    return "metadata-endpoint";
  }
  return "ok";
}

function ipv6Verdict(host: string): "ok" | "private-network" | "metadata-endpoint" {
  const lower = host.toLowerCase();
  if (lower === "::1" || lower === "::" || lower === "::ffff:127.0.0.1") {
    return "private-network";
  }
  if (lower.startsWith("fe80:") || lower.startsWith("fe80::")) {
    return "private-network";
  }
  if (
    lower.startsWith("fc") ||
    lower.startsWith("fd") ||
    lower === "fc00::" ||
    lower.startsWith("fc00:") ||
    lower.startsWith("fd00:")
  ) {
    const firstByte = Number.parseInt(lower.slice(0, 2), 16);
    if (Number.isInteger(firstByte) && (firstByte & 0xfe) === 0xfc) {
      return "private-network";
    }
  }
  if (lower.startsWith("ff")) {
    return "private-network";
  }
  const mapped = /^::ffff:(\d+\.\d+\.\d+\.\d+)$/.exec(lower);
  if (mapped !== null) {
    const embedded = parseIpv4(mapped[1] as string);
    if (embedded === undefined) {
      return "private-network";
    }
    return ipv4Verdict(embedded);
  }
  if (lower.includes(".")) {
    return "private-network";
  }
  return "ok";
}

const BLOCKED_EXACT_HOSTS = new Set([
  "localhost",
  "metadata.google.internal",
  "metadata.goog",
  "instance-data",
  "169.254.169.254",
]);

function hostVerdict(hostname: string): "ok" | "blocked-host" | "private-network" | "metadata-endpoint" {
  const host = hostname.toLowerCase();
  if (host.length === 0) {
    return "blocked-host";
  }
  if (BLOCKED_EXACT_HOSTS.has(host)) {
    return host === "169.254.169.254" ? "metadata-endpoint" : "blocked-host";
  }
  if (host.endsWith(".internal") || host.endsWith(".local") || host.endsWith(".internal.")) {
    return "blocked-host";
  }
  const ipv4 = parseIpv4(host);
  if (ipv4 !== undefined) {
    return ipv4Verdict(ipv4);
  }
  if (host.includes(":")) {
    return ipv6Verdict(host);
  }
  if (!host.includes(".")) {
    return "blocked-host";
  }
  return "ok";
}

export interface ParsedDestination {
  readonly url: string;
  readonly origin: string;
}

function parseDestination(rawUrl: string): ParsedDestination | Decision {
  let parsed: URL;
  try {
    parsed = new URL(rawUrl);
  } catch {
    return denied("invalid-url", `destination "${rawUrl}" is not a valid URL`);
  }
  if (parsed.protocol !== "https:") {
    return denied("unsupported-protocol", `protocol "${parsed.protocol}" is not permitted`);
  }
  const verdict = hostVerdict(parsed.hostname);
  if (verdict !== "ok") {
    if (verdict === "private-network") {
      return denied("private-network", `host "${parsed.hostname}" is a private/reserved address`);
    }
    if (verdict === "metadata-endpoint") {
      return denied("metadata-endpoint", `host "${parsed.hostname}" is a cloud metadata endpoint`);
    }
    return denied("blocked-host", `host "${parsed.hostname}" is not permitted`);
  }
  return { url: parsed.href, origin: parsed.origin };
}

/**
 * Validate one navigation destination: https, permitted host, and membership
 * in the job's allowed origins (exact origin match).
 */
export function validateDestination(rawUrl: string, allowedOrigins: readonly string[]): Decision {
  const parsed = parseDestination(rawUrl);
  if ("ok" in parsed && parsed.ok === false) {
    return parsed;
  }
  const destination = parsed as ParsedDestination;
  for (const origin of allowedOrigins) {
    if (destination.origin === origin) {
      return approved();
    }
  }
  return denied("origin-not-allowed", `origin "${destination.origin}" is outside the allowed origins`);
}

/**
 * Validate a full navigation including its redirect hops. Every hop is
 * checked like a destination and must stay inside the allowed origins;
 * downgrades and chains longer than five hops are denied.
 */
export function validateNavigation(
  rawUrl: string,
  redirectHops: readonly string[],
  allowedOrigins: readonly string[],
): Decision {
  if (redirectHops.length > MAX_REDIRECT_HOPS) {
    return denied("too-many-redirects", `${redirectHops.length} hops exceed the limit of ${MAX_REDIRECT_HOPS}`);
  }
  for (let index = 0; index < redirectHops.length; index += 1) {
    const hop = redirectHops[index] as string;
    const checked = validateDestination(hop, allowedOrigins);
    if (!checked.ok) {
      if (checked.reason === "origin-not-allowed") {
        return denied("redirect-origin-not-allowed", `redirect hop ${index} leaves the allowed origins`);
      }
      if (checked.reason === "unsupported-protocol") {
        return denied("redirect-downgrade", `redirect hop ${index} uses a forbidden protocol`);
      }
      return checked;
    }
  }
  return validateDestination(rawUrl, allowedOrigins);
}

/**
 * Check an interaction target against the latest observation. The target
 * must have been observed in the current document version and must not be
 * occluded; anything else (including arbitrary selector strings that were
 * never observed) is denied, and a stale document requires re-observation.
 */
export function checkTarget(
  observedTargets: readonly ObservedTarget[],
  currentDocumentVersion: string,
  targetId: string,
): Decision {
  let found: ObservedTarget | undefined;
  for (const target of observedTargets) {
    if (target.targetId === targetId) {
      found = target;
      break;
    }
  }
  if (found === undefined) {
    return denied("unknown-target", `target "${targetId}" was not observed in the current document`);
  }
  if (found.documentVersion !== currentDocumentVersion) {
    return denied(
      "stale-document",
      `target "${targetId}" belongs to document "${found.documentVersion}", current is "${currentDocumentVersion}"`,
    );
  }
  if (found.occluded) {
    return denied("occluded-target", `target "${targetId}" is occluded`);
  }
  return approved();
}
