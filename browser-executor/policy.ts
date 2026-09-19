// Destination policy and observed-target freshness.
//
// Model output never becomes a navigation destination unchecked: every URL
// (including every redirect hop) must be https, outside private/reserved
// network ranges and cloud metadata endpoints, and inside the job's allowed
// origins. Numeric addresses are classified by complete CIDR rules after
// WHATWG URL normalization (which already folds alternate IPv4 forms such as
// octal, hexadecimal, and integer notation into dotted decimal).
// Interaction targets must originate in the current observed DOM state:
// unknown target IDs (arbitrary selector strings), stale document versions,
// and occluded targets are all denied.

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
    value = value * 256 + octet;
  }
  return value >>> 0;
}

function inRange(address: number, base: number, bits: number): boolean {
  const shift = 32 - bits;
  return (address >>> shift) === (base >>> shift);
}

type NumericVerdict = "ok" | "private-network" | "metadata-endpoint";

function ipv4Verdict(address: number): NumericVerdict {
  if (inRange(address, 0x00000000, 8)) {
    return "private-network";
  }
  if (inRange(address, 0x7f000000, 8)) {
    return "private-network";
  }
  if (inRange(address, 0x0a000000, 8)) {
    return "private-network";
  }
  if (inRange(address, 0xac100000, 12)) {
    return "private-network";
  }
  if (inRange(address, 0xc0a80000, 16)) {
    return "private-network";
  }
  if (inRange(address, 0x64400000, 10)) {
    return "private-network";
  }
  if (inRange(address, 0xa9fe0000, 16)) {
    return "metadata-endpoint";
  }
  if (inRange(address, 0xe0000000, 4)) {
    return "private-network";
  }
  if (inRange(address, 0xf0000000, 4)) {
    return "private-network";
  }
  if (inRange(address, 0xc0000200, 24)) {
    return "private-network";
  }
  if (inRange(address, 0xc6336400, 24)) {
    return "private-network";
  }
  if (inRange(address, 0xcb007100, 24)) {
    return "private-network";
  }
  if (inRange(address, 0xc6120000, 15)) {
    return "private-network";
  }
  if (inRange(address, 0xc0000000, 24)) {
    return "private-network";
  }
  return "ok";
}

function parseHextet(text: string): number | undefined {
  if (text.length === 0 || text.length > 4 || !/^[0-9a-fA-F]+$/.test(text)) {
    return undefined;
  }
  return Number.parseInt(text, 16);
}

/** Expand an IPv6 literal (brackets already stripped) into eight groups. */
function expandIpv6(host: string): readonly number[] | undefined {
  let working = host;
  let tail: readonly number[] = [];
  const dotIndex = working.lastIndexOf(".");
  if (dotIndex !== -1) {
    const colonBefore = working.lastIndexOf(":", dotIndex);
    if (colonBefore === -1) {
      return undefined;
    }
    const embedded = parseIpv4(working.slice(colonBefore + 1));
    if (embedded === undefined) {
      return undefined;
    }
    tail = [(embedded >>> 16) & 0xffff, embedded & 0xffff];
    working = working.slice(0, colonBefore);
    if (working.endsWith(":")) {
      working = `${working}0`;
    }
  }
  const halves = working.split("::");
  if (halves.length > 2) {
    return undefined;
  }
  const first = halves[0] as string;
  const head = first === "" ? [] : first.split(":");
  const rest = halves.length === 2 ? (halves[1] as string) : undefined;
  const body = rest === undefined ? [] : rest === "" ? [] : rest.split(":");
  if (halves.length === 1 && head.length + tail.length !== 8) {
    return undefined;
  }
  const groups: number[] = [];
  for (const text of head) {
    const value = parseHextet(text);
    if (value === undefined) {
      return undefined;
    }
    groups.push(value);
  }
  const zeros = 8 - tail.length - groups.length - body.length;
  if (halves.length === 2 && zeros < 0) {
    return undefined;
  }
  for (let index = 0; index < zeros; index += 1) {
    groups.push(0);
  }
  for (const text of body) {
    const value = parseHextet(text);
    if (value === undefined) {
      return undefined;
    }
    groups.push(value);
  }
  for (const value of tail) {
    groups.push(value);
  }
  if (groups.length !== 8) {
    return undefined;
  }
  return groups;
}

function ipv6Verdict(host: string): NumericVerdict {
  const groups = expandIpv6(host);
  if (groups === undefined) {
    return "private-network";
  }
  const g0 = groups[0] as number;
  const g1 = groups[1] as number;
  const allZero = groups.every((value) => value === 0);
  if (allZero) {
    return "private-network";
  }
  if (g0 === 0 && groups.slice(1, 7).every((value) => value === 0) && groups[7] === 1) {
    return "private-network";
  }
  if ((g0 & 0xffc0) === 0xfe80) {
    return "private-network";
  }
  if ((g0 & 0xfe00) === 0xfc00) {
    return "private-network";
  }
  if ((g0 & 0xff00) === 0xff00) {
    return "private-network";
  }
  if (g0 === 0x2001 && g1 === 0x0db8) {
    return "private-network";
  }
  if (
    g0 === 0 &&
    groups[2] === 0 &&
    groups[3] === 0 &&
    groups[4] === 0 &&
    groups[5] === 0xffff
  ) {
    const embedded = (((groups[6] as number) * 65536 + (groups[7] as number)) >>> 0);
    return ipv4Verdict(embedded);
  }
  if (g0 === 0x2002) {
    const embedded = (((g1 as number) * 65536 + (groups[2] as number)) >>> 0);
    return ipv4Verdict(embedded);
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

function normalizeHostname(raw: string): string {
  let host = raw.toLowerCase();
  if (host.endsWith(".")) {
    host = host.slice(0, -1);
  }
  if (host.startsWith("[") && host.endsWith("]")) {
    host = host.slice(1, -1);
  }
  return host;
}

function hostVerdict(rawHostname: string): "ok" | "blocked-host" | "private-network" | "metadata-endpoint" {
  const host = normalizeHostname(rawHostname);
  if (host.length === 0) {
    return "blocked-host";
  }
  if (BLOCKED_EXACT_HOSTS.has(host)) {
    return host === "169.254.169.254" ? "metadata-endpoint" : "blocked-host";
  }
  if (host.endsWith(".internal") || host.endsWith(".local")) {
    return "blocked-host";
  }
  const ipv4 = parseIpv4(host);
  if (ipv4 !== undefined) {
    return ipv4Verdict(ipv4);
  }
  if (/^[0-9.]+$/.test(host)) {
    return "blocked-host";
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
 * in the job's allowed origins (exact origin match). Numeric policy applies
 * before the allowlist, so allowlisting a literal cannot admit it.
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
