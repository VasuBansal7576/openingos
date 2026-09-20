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
 */

import { mutation } from "../_generated/server";
import { v } from "convex/values";
import { normalizeMailbox, payloadHash } from "../shared/hashing.js";
import { COMMUNICATION_PROFILE_OWNER_ROLEPLAY } from "../shared/provenance.js";
import { checkProjectAccess, denialValidator, identityOf } from "../access/checks.js";

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/**
 * Record one controlled send for a claimed attempt token. Exactly one send
 * per token; replays are denied without a second effect.
 */
export const recordControlledSend = mutation({
  args: {
    operationId: v.string(),
    organizationId: v.string(),
    projectId: v.string(),
    token: v.string(),
    now: v.number(),
  },
  returns: v.union(
    v.object({ ok: v.literal(true), to: v.string(), payloadHash: v.string() }),
    denialValidator,
  ),
  handler: async (ctx, args) => {
    const identity = await identityOf(ctx);
    if (identity === null) {
      return { ok: false as const, code: "forged-identity", message: "unauthenticated" };
    }
    const access = await checkProjectAccess(
      ctx,
      identity,
      args.organizationId,
      args.projectId,
      "approver",
      args.now,
    );
    if (!access.ok) return { ok: false as const, code: access.code, message: access.message };
    const operation = (await ctx.db.get(args.operationId as never)) as unknown as {
      organizationId?: string;
      projectId?: string;
      kind?: string;
      state?: string;
      attemptToken?: string;
      normalizedPayload?: string;
      normalizedPayloadHash?: string;
      grantId?: string;
      recipientConfigVersion?: number;
    } | null;
    if (!operation || operation.organizationId !== args.organizationId || operation.projectId !== args.projectId) {
      return { ok: false as const, code: "denied-project", message: "operation is not in this project" };
    }
    if (operation.kind !== "communication.send" && operation.kind !== "communication.clarify") {
      return { ok: false as const, code: "denied-capability", message: "only communication operations dispatch mail" };
    }
    if (operation.state !== "dispatching" || operation.attemptToken !== args.token) {
      return { ok: false as const, code: "already-claimed", message: "attempt token is not valid for dispatch" };
    }
    const prior = (await ctx.db
      .query("outboundSnapshots")
      .filter((q) => q.eq(q.field("operationId"), args.operationId))
      .unique()) as unknown as { _id: string } | null;
    if (prior) {
      return { ok: false as const, code: "already-claimed", message: "this attempt was already dispatched" };
    }
    const grant = (await ctx.db.get((operation.grantId ?? "") as never)) as unknown as {
      recipientConfigVersion?: number;
      communicationProfile?: string;
    } | null;
    const configs = (await ctx.db.query("recipientConfigs").collect()) as unknown as {
      version: number;
      active: boolean;
      mailboxNormalized: string;
    }[];
    const recipient = configs.find((config) => config.active);
    if (!recipient) {
      return { ok: false as const, code: "missing-recipient-config", message: "owner recipient is not configured" };
    }
    if (
      operation.recipientConfigVersion !== (grant?.recipientConfigVersion ?? -1) ||
      (grant?.recipientConfigVersion ?? -1) !== recipient.version
    ) {
      return { ok: false as const, code: "stale-recipient-version", message: "recipient configuration changed; re-approval required" };
    }
    if (grant?.communicationProfile !== COMMUNICATION_PROFILE_OWNER_ROLEPLAY) {
      return { ok: false as const, code: "alternate-channel-denied", message: "only the owner-roleplay profile is permitted" };
    }
    let parsed: unknown;
    try {
      parsed = JSON.parse(operation.normalizedPayload ?? "");
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
      organizationId: args.organizationId,
      projectId: args.projectId,
      operationId: args.operationId as never,
      grantId: (operation.grantId ?? "") as never,
      to,
      cc: [],
      bcc: [],
      communicationProfile: COMMUNICATION_PROFILE_OWNER_ROLEPLAY,
      recipientConfigVersion: recipient.version,
      payloadHash: operation.normalizedPayloadHash ?? "",
      bodyHash: payloadHash(parsed["body"] ?? null),
      counterpartyRole: "ownerStandIn",
      createdAt: args.now,
    });
    return { ok: true as const, to, payloadHash: operation.normalizedPayloadHash ?? "" };
  },
});
