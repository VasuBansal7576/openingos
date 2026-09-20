/**
 * Bounded AgentMail reconciliation.
 *
 * Reconciliation is read-only and never retries a send. An exact one-message
 * match can confirm the already-dispatched effect; an empty, malformed or
 * ambiguous result remains unknown and retains the F1 reservation.
 */

import { makeFunctionReference, type RegisteredMutation } from "convex/server";
import { v } from "convex/values";
import { env, internalAction } from "../_generated/server.js";
import * as attempts from "../execution/attempts.js";
import * as reconciliation from "../execution/reconciliation.js";
import {
  DEFAULT_AGENTMAIL_BASE_URL,
  EU_AGENTMAIL_BASE_URL,
  MAX_PROVIDER_RESPONSE_BYTES,
  MAX_RECONCILIATION_READS,
  parseProviderReconciliationMessages,
  reconcileProviderMessages,
  type ReconciliationResult,
} from "./contracts.js";
import { operationLabel } from "./transport.js";
import { denialValidator } from "../access/checks.js";
import { isValidSingleMailbox, normalizeMailbox } from "../shared/mailbox.js";

type LocalMutationArgs<T> = T extends RegisteredMutation<infer _Visibility, infer Args, infer _Return> ? Args : never;
type LocalMutationReturn<T> = T extends RegisteredMutation<infer _Visibility, infer _Args, infer Return> ? Awaited<Return> : never;

const crashRef = makeFunctionReference<
  "mutation",
  LocalMutationArgs<typeof attempts.reconcileAfterCrash>,
  LocalMutationReturn<typeof attempts.reconcileAfterCrash>
>("execution/attempts:reconcileAfterCrash");
const lateRef = makeFunctionReference<
  "mutation",
  LocalMutationArgs<typeof reconciliation.recordLateDelivery>,
  LocalMutationReturn<typeof reconciliation.recordLateDelivery>
>("execution/reconciliation:recordLateDelivery");

export interface ReconciliationFetchInput {
  readonly inboxId: string;
  readonly recipient: string;
  readonly subject: string;
  readonly operationLabel: string;
  readonly baseUrl?: string;
  readonly fetchImpl?: (input: string, init?: RequestInit) => Promise<Response>;
  readonly maxReads?: number;
}

export interface ReconciliationFetchResult {
  readonly outcome: ReconciliationResult;
  readonly reads: number;
}

function allowedBaseUrl(value: string): boolean {
  return value === DEFAULT_AGENTMAIL_BASE_URL || value === EU_AGENTMAIL_BASE_URL;
}

async function readResponse(response: Response): Promise<unknown | null> {
  const text = await response.text();
  if (new TextEncoder().encode(text).byteLength > MAX_PROVIDER_RESPONSE_BYTES) return null;
  try {
    return JSON.parse(text) as unknown;
  } catch {
    return null;
  }
}

/** Read at most three bounded pages and classify only exact matches. */
export async function reconcileAgentMailOnce(input: ReconciliationFetchInput): Promise<ReconciliationFetchResult> {
  const baseUrl = input.baseUrl ?? DEFAULT_AGENTMAIL_BASE_URL;
  if (!allowedBaseUrl(baseUrl) || input.inboxId.trim().length === 0) {
    return { outcome: { kind: "unknown", reason: "malformed" }, reads: 0 };
  }
  const fetchImpl = input.fetchImpl ?? fetch;
  const maxReads = Math.max(1, Math.min(MAX_RECONCILIATION_READS, Math.floor(input.maxReads ?? MAX_RECONCILIATION_READS)));
  const endpoint = `${baseUrl.replace(/\/$/, "")}/inboxes/${encodeURIComponent(input.inboxId)}/messages?limit=25`;
  for (let read = 1; read <= maxReads; read += 1) {
    try {
      const response = await fetchImpl(endpoint, {
        method: "GET",
        redirect: "error",
        cache: "no-store",
        headers: { Authorization: `Bearer ${input.operationLabel}` },
      });
      if (!response.ok) return { outcome: { kind: "unknown", reason: "malformed" }, reads: read };
      const body = await readResponse(response);
      const messages = body === null ? null : parseProviderReconciliationMessages(body);
      if (messages === null) return { outcome: { kind: "unknown", reason: "malformed" }, reads: read };
      const result = reconcileProviderMessages(messages, input);
      if (result.kind === "confirmed") return { outcome: result, reads: read };
      if (result.reason === "ambiguous") return { outcome: result, reads: read };
    } catch {
      return { outcome: { kind: "unknown", reason: "malformed" }, reads: read };
    }
  }
  return { outcome: { kind: "unknown", reason: "empty" }, reads: maxReads };
}

const actionResultValidator = v.union(
  v.object({ ok: v.literal(true), outcome: v.union(v.literal("confirmed"), v.literal("unknown")), reads: v.number(), providerMessageId: v.union(v.string(), v.null()) }),
  denialValidator,
);

/** Internal reconciliation action. It records no fake success on uncertainty. */
export const reconcile = internalAction({
  args: {
    operationId: v.id("operations"),
    attemptToken: v.string(),
    inboxId: v.string(),
    recipient: v.string(),
    subject: v.string(),
  },
  returns: actionResultValidator,
  handler: async (ctx, args) => {
    const apiKey = env.AGENTMAIL_API_KEY;
    if (apiKey === undefined || apiKey.trim().length === 0) {
      return { ok: false as const, code: "provider-unavailable", message: "AgentMail is unavailable for reconciliation" };
    }
    const owner = env.HACKATHON_OWNER_RECIPIENT;
    if (
      owner === undefined ||
      !isValidSingleMailbox(owner) ||
      !isValidSingleMailbox(args.recipient) ||
      normalizeMailbox(owner) !== normalizeMailbox(args.recipient)
    ) {
      return { ok: false as const, code: "recipient-mismatch", message: "reconciliation recipient is not the configured owner mailbox" };
    }
    const baseUrl = env.AGENTMAIL_BASE_URL ?? DEFAULT_AGENTMAIL_BASE_URL;
    const result = await reconcileAgentMailOnce({
      inboxId: args.inboxId,
      recipient: args.recipient,
      subject: args.subject,
      operationLabel: operationLabel(String(args.operationId)),
      ...(baseUrl === undefined ? {} : { baseUrl }),
      fetchImpl: async (input, init) => {
        const headers = new Headers(init?.headers);
        headers.set("Authorization", `Bearer ${apiKey}`);
        return await fetch(input, { ...init, headers });
      },
    });
    if (result.outcome.kind === "confirmed") {
      const late: LocalMutationReturn<typeof reconciliation.recordLateDelivery> = await ctx.runMutation(lateRef, {
        operationId: args.operationId,
        token: args.attemptToken,
        providerEventId: result.outcome.message.messageId,
        provider: "agentmail",
        environment: "live",
      });
      return {
        ok: true as const,
        outcome: late.ok ? "confirmed" as const : "unknown" as const,
        reads: result.reads,
        providerMessageId: late.ok ? result.outcome.message.messageId : null,
      };
    }
    await ctx.runMutation(crashRef, { operationId: args.operationId });
    return {
      ok: true as const,
      outcome: "unknown" as const,
      reads: result.reads,
      providerMessageId: null,
    };
  },
});
