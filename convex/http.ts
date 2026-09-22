import { AgentMail, vEvent, type AgentMailComponent } from "@agentmail/convex";
import { registerStaticRoutes } from "@convex-dev/static-hosting";
import type { ComponentApi } from "@convex-dev/static-hosting/_generated/component";
import { httpRouter, makeFunctionReference, type RegisteredMutation } from "convex/server";
import { internal } from "./_generated/api";
import { httpAction, internalMutation } from "./_generated/server";
import { v } from "convex/values";
import { auth } from "./auth";
import * as communicationCallbacks from "./communication/callbacks";
import { components } from "./models/components";

type MutationArgs<T> = T extends RegisteredMutation<infer _Visibility, infer Args, infer _Return> ? Args : never;
type MutationReturn<T> = T extends RegisteredMutation<infer _Visibility, infer _Args, infer Return> ? Awaited<Return> : never;

const communicationEventRef = makeFunctionReference<
  "mutation",
  MutationArgs<typeof communicationCallbacks.onAgentMailEvent>,
  MutationReturn<typeof communicationCallbacks.onAgentMailEvent>
>("communication/callbacks:onAgentMailEvent");
const communicationMessageRef = makeFunctionReference<
  "mutation",
  MutationArgs<typeof communicationCallbacks.onAgentMailMessageReceived>,
  MutationReturn<typeof communicationCallbacks.onAgentMailMessageReceived>
>("communication/callbacks:onAgentMailMessageReceived");

/** Forward signature-verified AgentMail events into C1's idempotent ledger. */
export const onAgentMailEvent = internalMutation({
  args: { event: vEvent },
  returns: v.null(),
  handler: async (ctx, args) => {
    await ctx.runMutation(communicationEventRef, args);
    return null;
  },
});

export const onAgentMailMessageReceived = internalMutation({
  args: { message: v.any(), thread: v.any(), eventId: v.string() },
  returns: v.null(),
  handler: async (ctx, args) => {
    await ctx.runMutation(communicationMessageRef, args);
    return null;
  },
});

// `componentsGeneric` is intentionally untyped until a deployment can emit
// named refs; Convex guarantees this key from the config registration above.
const agentmail = new AgentMail(components.agentmail as unknown as AgentMailComponent, {
  retryAttempts: 3,
  initialBackoffMs: 1_000,
  onEvent: internal.http.onAgentMailEvent,
  onMessageReceived: internal.http.onAgentMailMessageReceived,
});

const http = httpRouter();
auth.addHttpRoutes(http);

http.route({
  path: "/agentmail/webhook",
  method: "POST",
  handler: httpAction(async (ctx, request) => {
    // AgentMail 0.1.0 ships its RunMutationCtx type against an older Convex
    // peer; this object is the exact runtime surface its implementation uses.
    const mutationContext = { runMutation: ctx.runMutation } as Parameters<AgentMail["handleWebhook"]>[0];
    return await agentmail.handleWebhook(mutationContext, request);
  }),
});

// Static SPA catch-all comes last: exact routes registered above win over it.
// Same intentional untyped-component cast as `components.agentmail` above.
registerStaticRoutes(http, components.staticHosting as unknown as ComponentApi);

export default http;
