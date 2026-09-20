/**
 * C1 outbound communication orchestration.
 *
 * The action is intentionally thin: prepare an immutable app-owned snapshot,
 * call the F1 atomic claim, make one REST request, then record the provider
 * outcome. It never uses AgentMail's independent outbound queue.
 */

import { makeFunctionReference, type RegisteredMutation } from "convex/server";
import { v } from "convex/values";
import { env, internalAction } from "../_generated/server.js";
import { f1InternalMutation } from "../server.js";
import * as attempts from "../execution/attempts.js";
import * as operations from "../execution/operations.js";
import * as reconciliation from "../execution/reconciliation.js";
import { COMMUNICATION_PROFILE_OWNER_ROLEPLAY } from "../shared/provenance.js";
import { payloadHash } from "../shared/hashing.js";
import { denialValidator } from "../access/checks.js";
import {
  providerPayloadFromOutbound,
  validateOutboundPayload,
  isCommunicationDenial,
  type CommunicationDenial,
} from "./contracts.js";
import { operationLabel, sendAgentMailOneShot } from "./transport.js";

type MutationArgs<T> = T extends RegisteredMutation<infer _Visibility, infer Args, infer _Return> ? Args : never;
type MutationReturn<T> = T extends RegisteredMutation<infer _Visibility, infer _Args, infer Return> ? Awaited<Return> : never;

const claimRef = makeFunctionReference<
  "mutation",
  MutationArgs<typeof operations.claim>,
  MutationReturn<typeof operations.claim>
>("execution/operations:claim");
const outcomeRef = makeFunctionReference<
  "mutation",
  MutationArgs<typeof attempts.recordOutcome>,
  MutationReturn<typeof attempts.recordOutcome>
>("execution/attempts:recordOutcome");
const lateDeliveryRef = makeFunctionReference<
  "mutation",
  MutationArgs<typeof reconciliation.recordLateDelivery>,
  MutationReturn<typeof reconciliation.recordLateDelivery>
>("execution/reconciliation:recordLateDelivery");

const snapshotResultValidator = v.union(
  v.object({
    ok: v.literal(true),
    snapshotId: v.id("outboundSnapshots"),
    deduplicated: v.boolean(),
    payloadJson: v.string(),
    inboxId: v.string(),
  }),
  denialValidator,
);

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function parseObject(canonical: string): Record<string, unknown> | null {
  try {
    const parsed: unknown = JSON.parse(canonical);
    return isRecord(parsed) ? parsed : null;
  } catch {
    return null;
  }
}

function denial(code: CommunicationDenial["code"], message: string): { ok: false; code: string; message: string } {
  return { ok: false, code, message };
}

/**
 * Persist the app-owned outbound snapshot before the external effect. The
 * schema intentionally stores hashes and protected binding metadata, not a
 * separate public body projection; the exact approved body remains bound to
 * the F1 operation payload while quote evidence stores only redacted
 * derivatives.
 */
export const prepareOutboundSnapshot = f1InternalMutation({
  args: { operationId: v.id("operations"), inboxId: v.string() },
  returns: snapshotResultValidator,
  handler: async (ctx, args) => {
    if (!/^[A-Za-z0-9._:-]{1,160}$/.test(args.inboxId)) {
      return denial("invalid-payload", "provider inbox id is invalid");
    }
    const operation = await ctx.db.get(args.operationId);
    if (operation === null) return denial("invalid-payload", "operation is not available");
    if (operation.kind !== "communication.send" && operation.kind !== "communication.clarify") {
      return denial("alternate-channel-denied", "operation is not an outbound communication");
    }
    if (operation.state !== "prepared" && operation.state !== "dispatching") {
      return denial("invalid-payload", `operation is ${operation.state}`);
    }
    const job = await ctx.db.get(operation.jobId);
    if (job === null) return denial("invalid-payload", "job is not available");
    if (job.state === "cancelled" || job.state === "cancelling") {
      return denial("alternate-channel-denied", "job is fenced for cancellation");
    }
    const grant = await ctx.db.get(operation.grantId);
    if (
      grant === null ||
      grant.organizationId !== operation.organizationId ||
      grant.projectId !== operation.projectId ||
      grant.communicationProfile !== COMMUNICATION_PROFILE_OWNER_ROLEPLAY
    ) {
      return denial("alternate-channel-denied", "communication grant is not owner-roleplay bound");
    }
    if (grant.status !== "active" || grant.revocationVersion !== operation.grantVersion || grant.expiresAt <= Date.now()) {
      return denial("alternate-channel-denied", "communication grant is stale, revoked, or expired");
    }
    if (grant.conversationId !== undefined) {
      const conversation = await ctx.db.get(grant.conversationId);
      if (
        conversation === null ||
        conversation.organizationId !== operation.organizationId ||
        conversation.projectId !== operation.projectId ||
        conversation.state === "cancelled" ||
        conversation.state === "closed" ||
        (operation.conversationVersion !== undefined && conversation.version !== operation.conversationVersion)
      ) {
        return denial("alternate-channel-denied", "communication conversation is stale or closed");
      }
    }
    const activeRecipients = await ctx.db
      .query("recipientConfigs")
      .withIndex("by_active", (q) => q.eq("active", true))
      .take(2);
    if (activeRecipients.length !== 1) {
      return denial("missing-recipient-config", "owner recipient is not configured uniquely");
    }
    const recipient = activeRecipients[0];
    if (recipient === undefined || recipient.version !== grant.recipientConfigVersion) {
      return denial("recipient-mismatch", "recipient configuration changed; re-approval required");
    }
    const value = parseObject(operation.normalizedPayload);
    if (value === null) return denial("invalid-payload", "operation payload is invalid JSON");
    const validated = validateOutboundPayload(value, recipient.mailboxNormalized);
    if (isCommunicationDenial(validated)) return validated;
    if (validated.canonical !== operation.normalizedPayload) {
      return denial("invalid-payload", "payload canonical form changed");
    }
    if (operation.normalizedPayload !== grant.canonicalPayload || validated.normalizedPayloadHash !== operation.normalizedPayloadHash) {
      return denial("invalid-payload", "approved communication draft changed");
    }
    const existingRows = await ctx.db
      .query("outboundSnapshots")
      .withIndex("by_operation", (q) => q.eq("operationId", args.operationId))
      .take(2);
    if (existingRows.length > 1) return denial("invalid-payload", "duplicate outbound snapshots detected");
    const existing = existingRows[0];
    if (existing !== undefined) {
      if (
        existing.payloadHash !== operation.normalizedPayloadHash ||
        existing.to !== validated.payload.to ||
        existing.recipientConfigVersion !== recipient.version
      ) {
        return denial("invalid-payload", "stored outbound snapshot does not match the operation");
      }
      return {
        ok: true as const,
        snapshotId: existing._id,
        deduplicated: true,
        payloadJson: operation.normalizedPayload,
        inboxId: args.inboxId,
      };
    }
    const snapshotId = await ctx.db.insert("outboundSnapshots", {
      organizationId: operation.organizationId,
      projectId: operation.projectId,
      operationId: operation._id,
      grantId: grant._id,
      to: validated.payload.to,
      cc: [],
      bcc: [],
      communicationProfile: COMMUNICATION_PROFILE_OWNER_ROLEPLAY,
      recipientConfigVersion: recipient.version,
      payloadHash: operation.normalizedPayloadHash,
      bodyHash: payloadHash(validated.payload.body),
      counterpartyRole: "ownerStandIn",
      createdAt: Date.now(),
    });
    return {
      ok: true as const,
      snapshotId,
      deduplicated: false,
      payloadJson: operation.normalizedPayload,
      inboxId: args.inboxId,
    };
  },
});

const bindingResultValidator = v.union(
  v.object({ ok: v.literal(true), bound: v.boolean(), applied: v.boolean() }),
  denialValidator,
);

interface BindingFacts {
  readonly eventId: string;
  readonly eventType: string;
  readonly messageId: string;
  readonly threadId: string;
  readonly inboxId: string;
}

function bindingFacts(value: unknown): BindingFacts | null {
  if (!isRecord(value)) return null;
  const eventId = value["eventId"];
  const eventType = value["eventType"];
  const messageId = value["messageId"];
  const threadId = value["threadId"];
  const inboxId = value["inboxId"];
  if (
    typeof eventId !== "string" ||
    typeof eventType !== "string" ||
    typeof messageId !== "string" ||
    typeof threadId !== "string" ||
    typeof inboxId !== "string"
  ) return null;
  return { eventId, eventType, messageId, threadId, inboxId };
}

/**
 * Bind an out-of-order callback to the provider response. Binding rows are
 * stored in F1's processed-event ledger as compact, redacted facts, so no
 * second table or unbounded message mirror is introduced by C1.
 */
export const recordProviderBinding = f1InternalMutation({
  args: {
    operationId: v.id("operations"),
    messageId: v.string(),
    threadId: v.string(),
    inboxId: v.string(),
  },
  returns: bindingResultValidator,
  handler: async (ctx, args) => {
    if (args.messageId.trim().length === 0 || args.threadId.trim().length === 0) {
      return denial("invalid-payload", "provider response identifiers are required");
    }
    const operation = await ctx.db.get(args.operationId);
    if (operation === null) return denial("invalid-payload", "operation is not available");
    if (operation.kind !== "communication.send" && operation.kind !== "communication.clarify") {
      return denial("alternate-channel-denied", "operation is not communication-bound");
    }
    const scope = { organizationId: operation.organizationId, projectId: operation.projectId };
    const existing = await ctx.db
      .query("processedEvents")
      .withIndex("by_provider_environment_and_event", (q) =>
        q.eq("provider", "agentmail-binding").eq("environment", "live").eq("eventId", args.messageId),
      )
      .unique();
    if (existing !== null) {
      if (
        existing.organizationId !== scope.organizationId ||
        existing.projectId !== scope.projectId ||
        existing.operationId !== args.operationId
      ) {
        return denial("invalid-payload", "provider message is already bound to another project");
      }
      const applied = existing.applicationState === "observedSuccess" || operation.state === "observedSuccess";
      if (applied && existing.applicationState !== "observedSuccess") {
        await ctx.db.patch(existing._id, {
          applicationOutcome: "success",
          applicationState: "observedSuccess",
          appliedAt: Date.now(),
        });
      }
      return { ok: true as const, bound: true, applied };
    }

    const now = Date.now();
    let applied = false;
    const unboundRows = await ctx.db.query("processedEvents").take(128);
    for (const row of unboundRows) {
      if (row.provider !== "agentmail-callback" || row.environment !== "live") continue;
      const facts = bindingFacts(parseObject(row.outcome));
      if (facts === null || facts.messageId !== args.messageId) continue;
      if (row.organizationId !== undefined && row.organizationId !== scope.organizationId) {
        return denial("invalid-payload", "callback belongs to another organization");
      }
      if (row.projectId !== undefined && row.projectId !== scope.projectId) {
        return denial("invalid-payload", "callback belongs to another project");
      }
      await ctx.db.patch(row._id, {
        organizationId: scope.organizationId,
        projectId: scope.projectId,
        operationId: args.operationId,
        applicationOutcome: facts.eventType === "message.sent" || facts.eventType === "message.delivered" ? "success" : "unknown",
        applicationState: facts.eventType === "message.sent" || facts.eventType === "message.delivered" ? "observedSuccess" : "outcomeUnknown",
        appliedAt: now,
      });
      if (facts.eventType === "message.sent" || facts.eventType === "message.delivered") {
        const token = operation.attemptToken;
        if (operation.state === "observedSuccess") {
          applied = true;
        } else if (token !== undefined) {
          const late: MutationReturn<typeof reconciliation.recordLateDelivery> = await ctx.runMutation(lateDeliveryRef, {
            operationId: args.operationId,
            token,
            providerEventId: facts.eventId,
            provider: "agentmail",
            environment: "live",
          });
          applied = late.ok;
        }
      }
      break;
    }
    await ctx.db.insert("processedEvents", {
      provider: "agentmail-binding",
      environment: "live",
      eventId: args.messageId,
      processingVersion: 1,
      outcome: JSON.stringify({ messageId: args.messageId, threadId: args.threadId, inboxId: args.inboxId }),
      ...scope,
      operationId: args.operationId,
      applicationOutcome: applied ? "success" : "unknown",
      applicationState: applied ? "observedSuccess" : "outcomeUnknown",
      ...(applied ? { appliedAt: now } : {}),
      createdAt: now,
    });
    return { ok: true as const, bound: true, applied };
  },
});

const dispatchResultValidator = v.union(
  v.object({
    ok: v.literal(true),
    outcome: v.union(v.literal("success"), v.literal("failure"), v.literal("unknown")),
    providerMessageId: v.union(v.string(), v.null()),
    providerThreadId: v.union(v.string(), v.null()),
    recorded: v.boolean(),
  }),
  denialValidator,
);

/** Internal one-shot dispatch. Never exposed to browsers. */
export const dispatch = internalAction({
  args: {
    operationId: v.id("operations"),
    identity: v.string(),
    inboxId: v.string(),
  },
  returns: dispatchResultValidator,
  handler: async (ctx, args) => {
    const apiKey = env.AGENTMAIL_API_KEY;
    if (apiKey === undefined || apiKey.trim().length === 0) {
      return denial("provider-rejection", "AgentMail allowance or credentials are unavailable");
    }
    const prepared: MutationReturn<typeof prepareOutboundSnapshot> = await ctx.runMutation(
      makeFunctionReference<
        "mutation",
        MutationArgs<typeof prepareOutboundSnapshot>,
        MutationReturn<typeof prepareOutboundSnapshot>
      >("communication/send:prepareOutboundSnapshot"),
      { operationId: args.operationId, inboxId: args.inboxId },
    );
    if (!prepared.ok) return prepared;
    const owner = env.HACKATHON_OWNER_RECIPIENT;
    if (owner === undefined || owner.trim().length === 0) {
      return denial("missing-recipient-config", "owner recipient is not configured for transport");
    }
    const value: unknown = JSON.parse(prepared.payloadJson);
    const outbound = validateOutboundPayload(value, owner);
    if (isCommunicationDenial(outbound)) return outbound;
    const claim: MutationReturn<typeof operations.claim> = await ctx.runMutation(claimRef, {
      operationId: args.operationId,
      identity: args.identity,
    });
    if (!claim.ok) return claim;
    const transport = await sendAgentMailOneShot({
      apiKey,
      inboxId: args.inboxId,
      ownerMailbox: owner,
      payload: providerPayloadFromOutbound(outbound.payload),
      operationLabel: operationLabel(String(args.operationId)),
      ...(env.AGENTMAIL_BASE_URL === undefined ? {} : { baseUrl: env.AGENTMAIL_BASE_URL }),
    });
    let recorded = false;
    if (transport.outcome === "success") {
      const outcome: MutationReturn<typeof attempts.recordOutcome> = await ctx.runMutation(outcomeRef, {
        operationId: args.operationId,
        token: claim.attemptToken,
        provider: "agentmail",
        environment: "live",
        providerEventId: transport.providerEventId,
        outcome: "success",
        detail: "AgentMail accepted one direct REST send",
      });
      recorded = outcome.ok;
      if (!outcome.ok) return outcome;
      const binding: MutationReturn<typeof recordProviderBinding> = await ctx.runMutation(
        makeFunctionReference<
          "mutation",
          MutationArgs<typeof recordProviderBinding>,
          MutationReturn<typeof recordProviderBinding>
        >("communication/send:recordProviderBinding"),
        {
          operationId: args.operationId,
          messageId: transport.response.messageId,
          threadId: transport.response.threadId,
          inboxId: args.inboxId,
        },
      );
      if (!binding.ok) return binding;
      return {
        ok: true as const,
        outcome: "success" as const,
        providerMessageId: transport.response.messageId,
        providerThreadId: transport.response.threadId,
        recorded,
      };
    }
    const outcome: MutationReturn<typeof attempts.recordOutcome> = await ctx.runMutation(outcomeRef, {
      operationId: args.operationId,
      token: claim.attemptToken,
      provider: "agentmail",
      environment: "live",
      outcome: transport.outcome === "failure" ? "failure" : "unknown",
      ...(transport.outcome === "unknown" ? { unknownCharges: true } : {}),
      detail: transport.outcome === "failure" ? transport.denial.message : transport.reason,
    });
    recorded = outcome.ok;
    return {
      ok: true as const,
      outcome: transport.outcome,
      providerMessageId: transport.providerEventId ?? null,
      providerThreadId: null,
      recorded,
    };
  },
});
