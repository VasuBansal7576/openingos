/**
 * F1 owner-only controlled send record (controlled contract, S-22).
 *
 * The shared application workflow owns outbound AgentMail transport (C1);
 * this F1 module owns the authorization gate the transport must pass: the
 * dispatch claim and this adapter both validate `ownerRoleplay`, the exact
 * configured recipient and version, `To`-only addressing, empty CC/BCC, and
 * no Reply-To redirection. Missing configuration, recipient mismatch, or an
 * alternate channel produces a typed denial with no send. The controlled
 * record never performs a live provider call.
 *
 * Visibility: internal executor transition, invoked only by the authorized
 * dispatch action after a successful internal claim. Browsers cannot record
 * sends, so header smuggling through a direct call is impossible.
 */

import { v } from "convex/values";
import { f1InternalMutation } from "../server.js";
import { normalizeMailbox, payloadHash } from "../shared/hashing.js";
import { COMMUNICATION_PROFILE_OWNER_ROLEPLAY } from "../shared/provenance.js";
import { denialValidator } from "../access/checks.js";

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/** Internal: record one controlled send for a claimed attempt token. */
export const recordControlledSend = f1InternalMutation({
  args: { operationId: v.id("operations"), token: v.string() },
  returns: v.union(
    v.object({ ok: v.literal(true), to: v.string(), payloadHash: v.string() }),
    denialValidator,
  ),
  handler: async (ctx, args) => {
    const now = Date.now();
    const operation = await ctx.db.get(args.operationId);
    if (operation === null) {
      return { ok: false as const, code: "denied-membership", message: "not authorized for this project" };
    }
    if (operation.kind !== "communication.send" && operation.kind !== "communication.clarify") {
      return { ok: false as const, code: "denied-capability", message: "only communication operations dispatch mail" };
    }
    if (operation.state !== "dispatching" || operation.attemptToken !== args.token) {
      return { ok: false as const, code: "already-claimed", message: "attempt token is not valid for dispatch" };
    }
    const prior = await ctx.db
      .query("outboundSnapshots")
      .withIndex("by_operation", (q) => q.eq("operationId", args.operationId))
      .unique();
    if (prior !== null) {
      return { ok: false as const, code: "already-claimed", message: "this attempt was already dispatched" };
    }
    const grant = await ctx.db.get(operation.grantId);
    if (grant === null) {
      return { ok: false as const, code: "denied-membership", message: "not authorized for this project" };
    }
    const recipient = await ctx.db
      .query("recipientConfigs")
      .withIndex("by_active", (q) => q.eq("active", true))
      .unique();
    if (recipient === null) {
      return { ok: false as const, code: "missing-recipient-config", message: "owner recipient is not configured" };
    }
    if (
      operation.recipientConfigVersion !== grant.recipientConfigVersion ||
      grant.recipientConfigVersion !== recipient.version
    ) {
      return { ok: false as const, code: "stale-recipient-version", message: "recipient configuration changed; re-approval required" };
    }
    if (grant.communicationProfile !== COMMUNICATION_PROFILE_OWNER_ROLEPLAY) {
      return { ok: false as const, code: "alternate-channel-denied", message: "only the owner-roleplay profile is permitted" };
    }
    let parsed: unknown;
    try {
      parsed = JSON.parse(operation.normalizedPayload);
    } catch {
      return { ok: false as const, code: "invalid-payload", message: "communication payload is not valid JSON" };
    }
    if (!isRecord(parsed)) {
      return { ok: false as const, code: "invalid-payload", message: "communication payload must be an object" };
    }
    const to = typeof parsed["to"] === "string" ? normalizeMailbox(parsed["to"]) : "";
    const cc = Array.isArray(parsed["cc"]) ? parsed["cc"] : null;
    const bcc = Array.isArray(parsed["bcc"]) ? parsed["bcc"] : null;
    if (to !== recipient.mailboxNormalized) {
      return { ok: false as const, code: "recipient-mismatch", message: "recipient is not the configured owner mailbox" };
    }
    if (cc === null || cc.length !== 0) {
      return { ok: false as const, code: "cc-not-empty", message: "CC must remain empty" };
    }
    if (bcc === null || bcc.length !== 0) {
      return { ok: false as const, code: "bcc-not-empty", message: "BCC must remain empty" };
    }
    if (parsed["replyTo"] !== undefined) {
      return { ok: false as const, code: "reply-to-redirect", message: "Reply-To redirection is denied" };
    }
    if (parsed["profile"] !== COMMUNICATION_PROFILE_OWNER_ROLEPLAY) {
      return { ok: false as const, code: "alternate-channel-denied", message: "only the owner-roleplay profile is permitted" };
    }
    await ctx.db.insert("outboundSnapshots", {
      organizationId: operation.organizationId,
      projectId: operation.projectId,
      operationId: args.operationId,
      grantId: operation.grantId,
      to,
      cc: [],
      bcc: [],
      communicationProfile: COMMUNICATION_PROFILE_OWNER_ROLEPLAY,
      recipientConfigVersion: recipient.version,
      payloadHash: operation.normalizedPayloadHash,
      bodyHash: payloadHash(parsed["body"] ?? null),
      counterpartyRole: "ownerStandIn",
      createdAt: now,
    });
    return { ok: true as const, to, payloadHash: operation.normalizedPayloadHash };
  },
});
