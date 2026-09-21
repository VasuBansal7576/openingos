/**
 * Bounded AgentMail reconciliation.
 *
 * Every provider GET is admitted by the execution module immediately before
 * dispatch. The action never treats a label or subject as proof: it compares
 * the immutable outbound snapshot and leaves missing, conflicting, timed-out
 * or exhausted evidence unknown.
 */

import { makeFunctionReference, type RegisteredMutation } from "convex/server";
import { v } from "convex/values";
import { env, internalAction } from "../_generated/server.js";
import * as attempts from "../execution/attempts.js";
import * as reconciliation from "../execution/reconciliation.js";
import {
  DEFAULT_AGENTMAIL_BASE_URL,
  EU_AGENTMAIL_BASE_URL,
  DEFAULT_RECONCILIATION_OVERALL_TIMEOUT_MS,
  DEFAULT_RECONCILIATION_READ_TIMEOUT_MS,
  MAX_PROVIDER_RESPONSE_BYTES,
  MAX_RECONCILIATION_READS,
  MAX_RECONCILIATION_TIMEOUT_MS,
  parseProviderReconciliationPage,
  reconcileProviderMessages,
  type ReconciliationMessage,
  type ReconciliationReadAdmission,
  type ReconciliationResult,
  type ReconciliationSnapshot,
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
  readonly operationLabel: string;
  /** Legacy hints are retained for source compatibility but never used as proof. */
  readonly recipient?: string;
  readonly subject?: string;
  /** Standalone controlled callers provide the already-validated snapshot. */
  readonly snapshot?: ReconciliationSnapshot;
  readonly baseUrl?: string;
  readonly fetchImpl?: (input: string, init?: RequestInit) => Promise<Response>;
  readonly maxReads?: number;
  readonly perReadTimeoutMs?: number;
  readonly overallTimeoutMs?: number;
  /** Production callers admit every read; the callback may provide the snapshot on read one. */
  readonly admitRead?: (read: number) => Promise<ReconciliationReadAdmission | boolean>;
}

export interface ReconciliationFetchResult {
  readonly outcome: ReconciliationResult;
  readonly reads: number;
}

function allowedBaseUrl(value: string): boolean {
  return value === DEFAULT_AGENTMAIL_BASE_URL || value === EU_AGENTMAIL_BASE_URL;
}

function boundedTimeout(value: number | undefined, fallback: number): number | null {
  const timeout = value ?? fallback;
  if (!Number.isSafeInteger(timeout) || timeout <= 0 || timeout > MAX_RECONCILIATION_TIMEOUT_MS) return null;
  return timeout;
}

function endpointFor(baseUrl: string, inboxId: string, pageToken: string | null): string {
  const query = new URLSearchParams({ limit: String(25) });
  if (pageToken !== null) query.set("page_token", pageToken);
  return `${baseUrl.replace(/\/$/, "")}/inboxes/${encodeURIComponent(inboxId)}/messages?${query.toString()}`;
}

async function awaitableRace<T>(promise: Promise<T>, timeoutMs: number, error: () => Error): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const timeout = new Promise<T>((_resolve, reject) => {
    timer = setTimeout(() => reject(error()), timeoutMs);
  });
  try {
    return await Promise.race([promise, timeout]);
  } finally {
    if (timer !== undefined) clearTimeout(timer);
  }
}

async function fetchWithDeadlines(
  fetchImpl: (input: string, init?: RequestInit) => Promise<Response>,
  endpoint: string,
  operationLabelValue: string,
  deadlineAt: number,
): Promise<{ readonly response: Response; readonly body: string }> {
  const controller = new AbortController();
  const remainingBeforeFetch = deadlineAt - Date.now();
  if (remainingBeforeFetch <= 0) throw new Error("reconciliation transport deadline exceeded");
  const response = await awaitableRace(
    fetchImpl(endpoint, {
      method: "GET",
      redirect: "error",
      cache: "no-store",
      signal: controller.signal,
      headers: { "X-OpeningOS-Operation": operationLabelValue },
    }),
    remainingBeforeFetch,
    () => {
      controller.abort();
      return new Error("reconciliation transport deadline exceeded");
    },
  );
  const remainingBeforeBody = deadlineAt - Date.now();
  if (remainingBeforeBody <= 0) throw new Error("reconciliation body deadline exceeded");
  const body = await awaitableRace(
    response.text(),
    remainingBeforeBody,
    () => {
      controller.abort();
      return new Error("reconciliation body deadline exceeded");
    },
  );
  return { response, body };
}

/**
 * Read bounded pages using the provider's actual continuation token. A page
 * is never reread, and an unconsumed continuation prevents confirmation even
 * when an earlier page contained one exact candidate.
 */
export async function reconcileAgentMailOnce(input: ReconciliationFetchInput): Promise<ReconciliationFetchResult> {
  const baseUrl = input.baseUrl ?? DEFAULT_AGENTMAIL_BASE_URL;
  if (!allowedBaseUrl(baseUrl) || input.inboxId.trim().length === 0) {
    return { outcome: { kind: "unknown", reason: "malformed" }, reads: 0 };
  }
  const fetchImpl = input.fetchImpl ?? fetch;
  const requestedReads = input.maxReads ?? MAX_RECONCILIATION_READS;
  if (!Number.isSafeInteger(requestedReads) || requestedReads < 1) {
    return { outcome: { kind: "unknown", reason: "malformed" }, reads: 0 };
  }
  if (input.admitRead === undefined && input.snapshot === undefined) {
    return { outcome: { kind: "unknown", reason: "malformed" }, reads: 0 };
  }
  const maxReads = Math.min(MAX_RECONCILIATION_READS, requestedReads);
  const perReadTimeoutMs = boundedTimeout(input.perReadTimeoutMs, DEFAULT_RECONCILIATION_READ_TIMEOUT_MS);
  const overallTimeoutMs = boundedTimeout(input.overallTimeoutMs, DEFAULT_RECONCILIATION_OVERALL_TIMEOUT_MS);
  if (perReadTimeoutMs === null || overallTimeoutMs === null) {
    return { outcome: { kind: "unknown", reason: "malformed" }, reads: 0 };
  }
  const deadline = Date.now() + overallTimeoutMs;
  let snapshot = input.snapshot;
  let pageToken: string | null = null;
  const seenPageTokens = new Set<string>();
  const messages: ReconciliationMessage[] = [];

  for (let read = 1; read <= maxReads; read += 1) {
    const remaining = deadline - Date.now();
    if (remaining <= 0) return { outcome: { kind: "unknown", reason: "exhausted" }, reads: read - 1 };
    const readDeadline = Math.min(deadline, Date.now() + perReadTimeoutMs);
    if (input.admitRead !== undefined) {
      let admission: ReconciliationReadAdmission | boolean;
      try {
        admission = await awaitableRace(
          input.admitRead(read),
          Math.max(1, readDeadline - Date.now()),
          () => new Error("reconciliation admission deadline exceeded"),
        );
      } catch {
        return { outcome: { kind: "unknown", reason: "malformed" }, reads: read - 1 };
      }
      if (admission === false || (typeof admission === "object" && admission.allowed === false)) {
        return { outcome: { kind: "unknown", reason: "exhausted" }, reads: read - 1 };
      }
      if (typeof admission === "object" && admission.snapshot !== undefined) snapshot = admission.snapshot;
    }
    if (snapshot === undefined) return { outcome: { kind: "unknown", reason: "malformed" }, reads: read - 1 };
    try {
      const fetched = await fetchWithDeadlines(
        fetchImpl,
        endpointFor(baseUrl, input.inboxId, pageToken),
        input.operationLabel,
        readDeadline,
      );
      if (!fetched.response.ok || new TextEncoder().encode(fetched.body).byteLength > MAX_PROVIDER_RESPONSE_BYTES) {
        return { outcome: { kind: "unknown", reason: "malformed" }, reads: read };
      }
      let body: unknown;
      try {
        body = JSON.parse(fetched.body) as unknown;
      } catch {
        return { outcome: { kind: "unknown", reason: "malformed" }, reads: read };
      }
      const page = parseProviderReconciliationPage(body);
      if (page === null) return { outcome: { kind: "unknown", reason: "malformed" }, reads: read };
      messages.push(...page.messages);
      if (page.nextPageToken === null) {
        return {
          outcome: reconcileProviderMessages(messages, { snapshot, operationLabel: input.operationLabel }),
          reads: read,
        };
      }
      if (seenPageTokens.has(page.nextPageToken)) {
        return { outcome: { kind: "unknown", reason: "malformed" }, reads: read };
      }
      seenPageTokens.add(page.nextPageToken);
      pageToken = page.nextPageToken;
    } catch {
      return { outcome: { kind: "unknown", reason: "malformed" }, reads: read };
    }
  }
  return { outcome: { kind: "unknown", reason: "exhausted" }, reads: maxReads };
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
    // Legacy callers may still pass these mutable hints. They are ignored;
    // the execution mutation derives the immutable snapshot instead.
    recipient: v.optional(v.string()),
    subject: v.optional(v.string()),
  },
  returns: actionResultValidator,
  handler: async (ctx, args) => {
    const apiKey = env.AGENTMAIL_API_KEY;
    if (apiKey === undefined || apiKey.trim().length === 0) {
      return { ok: false as const, code: "provider-unavailable", message: "AgentMail is unavailable for reconciliation" };
    }
    const owner = env.HACKATHON_OWNER_RECIPIENT;
    if (owner === undefined || !isValidSingleMailbox(owner)) {
      return { ok: false as const, code: "recipient-mismatch", message: "reconciliation recipient is not the configured owner mailbox" };
    }
    let admissionFailure: { readonly ok: false; readonly code: string; readonly message: string } | undefined;
    const readTokens: string[] = [];
    const baseUrl = env.AGENTMAIL_BASE_URL ?? DEFAULT_AGENTMAIL_BASE_URL;
    const result = await reconcileAgentMailOnce({
      inboxId: args.inboxId,
      operationLabel: operationLabel(String(args.operationId)),
      ...(baseUrl === undefined ? {} : { baseUrl }),
      admitRead: async (read) => {
        for (let candidate = read; candidate <= MAX_RECONCILIATION_READS; candidate += 1) {
          const admitted: LocalMutationReturn<typeof attempts.reconcileAfterCrash> = await ctx.runMutation(crashRef, {
            operationId: args.operationId,
            mode: "admitRead",
            attemptToken: args.attemptToken,
            readNumber: candidate,
          });
          if (!admitted.ok) {
            // Another action may have allocated this slot while this action
            // was waiting on the mutation. Skip only that occupied slot and
            // ask the ledger for the next global slot. All other denials
            // stop before any provider GET.
            if (admitted.code === "already-claimed") continue;
            admissionFailure = admitted;
            return false;
          }
          if (!("snapshot" in admitted)) {
            admissionFailure = { ok: false, code: "outcome-unknown", message: "reconciliation snapshot proof is unavailable" };
            return false;
          }
          readTokens.push(admitted.readToken);
          const admittedRecipients = typeof admitted.snapshot.to === "string" ? [admitted.snapshot.to] : admitted.snapshot.to;
          if (admittedRecipients.length !== 1 || normalizeMailbox(admittedRecipients[0] ?? "") !== normalizeMailbox(owner)) {
            admissionFailure = { ok: false, code: "recipient-mismatch", message: "reconciliation recipient is not the configured owner mailbox" };
            return false;
          }
          return { allowed: true as const, snapshot: admitted.snapshot };
        }
        admissionFailure = { ok: false, code: "already-claimed", message: "reconciliation read budget is already allocated" };
        return false;
      },
      fetchImpl: async (input, init) => {
        const headers = new Headers(init?.headers);
        headers.set("Authorization", `Bearer ${apiKey}`);
        return await fetch(input, { ...init, headers });
      },
    });
    if (admissionFailure !== undefined && result.reads === 0 && readTokens.length === 0) return admissionFailure;
    const finished: LocalMutationReturn<typeof attempts.reconcileAfterCrash> = await ctx.runMutation(crashRef, {
      operationId: args.operationId,
      mode: "finishReads",
      attemptToken: args.attemptToken,
      reads: readTokens.length,
      readTokens,
      outcome: result.outcome.kind === "confirmed" ? "confirmed" : "unknown",
      detail: result.outcome.kind === "confirmed" ? "provider snapshot matched" : `provider reconciliation ${result.outcome.reason}`,
    });
    if (!finished.ok) return { ok: false as const, code: finished.code, message: finished.message };
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
    return { ok: true as const, outcome: "unknown" as const, reads: result.reads, providerMessageId: null };
  },
});
