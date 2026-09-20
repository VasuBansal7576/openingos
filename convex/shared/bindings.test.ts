/**
 * F1 money, hashing, and digest-binding tests (controlled, ADR-0003/NR03).
 *
 * Money is integer minor units plus ISO currency. Payload equality is
 * decided by exact canonical-string comparison; FNV-1a is an index hint
 * and SHA-256 is a second binding when both sides present it.
 */

import { describe, expect, test } from "bun:test";
import { chargeBlocksCompleteOffer, checkCurrency, checkMoney, makeCheckedMoney } from "./money.js";
import { canonicalJson, payloadHash, requestKey } from "./hashing.js";
import { isValidSingleMailbox, normalizeMailbox } from "./mailbox.js";
import { sameCanonicalPayload, sha256BindingOk, sha256Hex, sha256HexSync } from "./sha256.js";

describe("money (integer minor units, ISO currency)", () => {
  test("accepts integer minor units with ISO code", () => {
    expect(makeCheckedMoney("EUR", 795000)).toEqual({ currency: "EUR", minorUnits: 795000 });
    expect(checkMoney({ currency: "EUR", minorUnits: 0 })).toEqual({ currency: "EUR", minorUnits: 0 });
  });

  test("rejects floating-point display strings and fractions", () => {
    expect(() => makeCheckedMoney("EUR", 79.5)).toThrow();
    expect(() => checkMoney({ currency: "EUR", minorUnits: "7950.00" })).toThrow();
  });

  test("rejects non-ISO currency codes", () => {
    expect(() => checkCurrency("euro")).toThrow();
    expect(() => checkCurrency("EU")).toThrow();
    expect(() => makeCheckedMoney("eur", 100)).toThrow();
  });

  test("unknown charges block complete-offer claims and stay unknown", () => {
    expect(chargeBlocksCompleteOffer("unknown")).toBe(true);
    expect(chargeBlocksCompleteOffer("known")).toBe(false);
    expect(chargeBlocksCompleteOffer("included")).toBe(false);
    expect(chargeBlocksCompleteOffer("estimated")).toBe(false);
  });
});

describe("canonical payload binding", () => {
  test("canonical form is key-order independent", () => {
    const left = canonicalJson({ to: "a@example.test", cc: [], profile: "ownerRoleplay" });
    const right = canonicalJson({ profile: "ownerRoleplay", cc: [], to: "a@example.test" });
    expect(left).toBe(right);
    expect(sameCanonicalPayload(left, right)).toBe(true);
  });

  test("any byte change breaks canonical equality (hash never overrides)", () => {
    const left = canonicalJson({ to: "a@example.test", amount: 1 });
    const right = canonicalJson({ to: "a@example.test", amount: 2 });
    expect(sameCanonicalPayload(left, right)).toBe(false);
    expect(payloadHash({ to: "a@example.test", amount: 1 })).toBe(payloadHash({ amount: 1, to: "a@example.test" }));
  });

  test("request keys bind organization, kind, and requestId", () => {
    expect(requestKey("org-1", "communication.send", "req-1")).toBe("org-1|communication.send|req-1");
    expect(requestKey("org-1", "communication.send", "req-1")).not.toBe(
      requestKey("org-2", "communication.send", "req-1"),
    );
  });

  test("mailbox normalization preserves the local part and lowercases only the domain", () => {
    expect(normalizeMailbox("  Owner-Supplier@Example.TEST ")).toBe("Owner-Supplier@example.test");
    expect(normalizeMailbox("owner-supplier@example.test")).toBe("owner-supplier@example.test");
    // No dot/plus folding: distinct local parts stay distinct.
    expect(normalizeMailbox("first.last+x@example.test")).not.toBe(normalizeMailbox("firstlast@example.test"));
  });

  test("single-mailbox validation admits one address and rejects the rest", () => {
    expect(isValidSingleMailbox("owner-supplier@example.test")).toBe(true);
    expect(isValidSingleMailbox("Owner-Supplier@Example.TEST")).toBe(true);
    expect(isValidSingleMailbox("owner-supplier@example.test,other@example.test")).toBe(false);
    expect(isValidSingleMailbox("Demo Supplier <owner-supplier@example.test>")).toBe(false);
    expect(isValidSingleMailbox("owner supplier@example.test")).toBe(false);
    expect(isValidSingleMailbox("owner-supplier@example.test;other@example.test")).toBe(false);
    expect(isValidSingleMailbox("not-an-address")).toBe(false);
    expect(isValidSingleMailbox("")).toBe(false);
  });

  test("SHA-256 digest is deterministic and exact (async validated boundary)", async () => {
    const payload = { to: "owner-supplier@example.test", cc: [] as string[] };
    const first = await sha256Hex(payload);
    const second = await sha256Hex({ cc: [], to: "owner-supplier@example.test" });
    expect(first).toBe(second);
    expect(first).toHaveLength(64);
    const changed = await sha256Hex({ to: "other@example.test", cc: [] as string[] });
    expect(changed).not.toBe(first);
  });

  test("synchronous SHA-256 matches crypto.subtle byte for byte", async () => {
    const vectors = ["", "abc", "owner-supplier@example.test|communication.send|req-1"];
    for (const text of vectors) {
      const bytes = new TextEncoder().encode(text);
      const subtle = await crypto.subtle.digest("SHA-256", bytes);
      const expected = [...new Uint8Array(subtle)]
        .map((byte) => byte.toString(16).padStart(2, "0"))
        .join("");
      expect(sha256HexSync(bytes)).toBe(expected);
    }
    expect(sha256HexSync(new TextEncoder().encode(""))).toBe(
      "e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855",
    );
  });

  test("digest cross-check fails closed only on present mismatch", () => {
    expect(sha256BindingOk(undefined, "abc")).toBe(true);
    expect(sha256BindingOk("abc", undefined)).toBe(true);
    expect(sha256BindingOk("abc", "abc")).toBe(true);
    expect(sha256BindingOk("abc", "def")).toBe(false);
  });
});
