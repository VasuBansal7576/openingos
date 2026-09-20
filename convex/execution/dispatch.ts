/**
 * F1 authorized dispatch actions (controlled contract, S-22/D-07).
 *
 * These public actions are the only product path into the internal
 * executor transitions. Each derives identity from `ctx.auth` and time
 * from the server clock, claims through the internal atomic claim, and
 * — only on a successful claim — records the controlled send. A browser
 * caller can invoke these actions but can never invoke the internal
 * transitions directly, and mere possession of an attempt token authorizes
 * nothing: outcomes and sends are recorded server-side from the fresh
 * claim result. Internal references are precisely typed with no assertions.
 */

import { v } from "convex/values";
import { f1Action } from "../server.js";
import { claimRef, resendRef, sendRef } from "../internalRefs.js";
import { denialValidator, identityOf } from "../access/checks.js";

/**
 * Claim and controlled-send one prepared communication operation.
 * Denials from either internal step propagate with zero new effect.
 */
export const dispatchCommunication = f1Action({
  args: { operationId: v.id("operations") },
  returns: v.union(
    v.object({
      ok: v.literal(true),
      operationId: v.id("operations"),
      to: v.string(),
      payloadHash: v.string(),
    }),
    denialValidator,
  ),
  handler: async (ctx, args) => {
    const identity = await identityOf(ctx);
    if (identity === null) {
      return { ok: false as const, code: "forged-identity", message: "unauthenticated" };
    }
    const claim = await ctx.runMutation(claimRef, {
      operationId: args.operationId,
      identity,
    });
    if (!claim.ok) return claim;
    const send = await ctx.runMutation(sendRef, {
      operationId: args.operationId,
      token: claim.attemptToken,
    });
    if (!send.ok) return send;
    return {
      ok: true as const,
      operationId: args.operationId,
      to: send.to,
      payloadHash: send.payloadHash,
    };
  },
});

/**
 * Approver-reviewed resend of an ambiguous operation. Routes through the
 * internal resend transition; the warning about a possible duplicate
 * external effect is always surfaced.
 */
export const requestResend = f1Action({
  args: { operationId: v.id("operations"), newRequestId: v.string() },
  returns: v.union(
    v.object({
      ok: v.literal(true),
      operationId: v.id("operations"),
      warning: v.string(),
    }),
    denialValidator,
  ),
  handler: async (ctx, args) => {
    const identity = await identityOf(ctx);
    if (identity === null) {
      return { ok: false as const, code: "forged-identity", message: "unauthenticated" };
    }
    const resend = await ctx.runMutation(resendRef, {
      operationId: args.operationId,
      identity,
      newRequestId: args.newRequestId,
    });
    if (!resend.ok) return resend;
    return { ok: true as const, operationId: resend.operationId, warning: resend.warning };
  },
});
