import { AgentMail, vEvent, type AgentMailComponent } from "@agentmail/convex";
import { httpRouter } from "convex/server";
import { internal } from "./_generated/api";
import { httpAction, internalMutation } from "./_generated/server";
import { v } from "convex/values";
import { auth } from "./auth";
import { components } from "./models/components";

/**
 * These callbacks are deliberately inert foundation sinks. F1 will replace
 * them with capability-checked product work only after signed AgentMail
 * delivery and idempotency have been established by the component.
 */
export const onAgentMailEvent = internalMutation({
  args: { event: vEvent },
  returns: v.null(),
  handler: async () => null,
});

export const onAgentMailMessageReceived = internalMutation({
  args: { message: v.any(), thread: v.any(), eventId: v.string() },
  returns: v.null(),
  handler: async () => null,
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

export default http;
