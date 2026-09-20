/**
 * F1 leaf typed internal references (controlled contract).
 *
 * The generated `_generated/api` runtime proxy resolves any registered
 * module path, but its stale types cannot name new F1 modules. This leaf
 * module binds the three internal transitions the public dispatch actions
 * need to precise `FunctionReference` types written against the same
 * validators the transitions declare — a hand-written owned helper with
 * no assertions, no dependency on handler modules (so no type cycle), and
 * no generated-file edits. The
 * validators on the transitions remain the runtime authority; these types
 * mirror them for compile-time safety.
 */

import { anyApi } from "convex/server";
import type { FunctionReference } from "convex/server";
import type { Id } from "./_generated/dataModel.js";

/**
 * The official dynamic reference proxy. Annotated (never asserted) at each
 * use site below so every reference carries its validator-mirroring type.
 */
const runtime: any = anyApi;

export interface DenialShape {
  readonly ok: false;
  readonly code: string;
  readonly message: string;
}

export type ClaimArgs = {
  readonly operationId: Id<"operations">;
  readonly identity: string;
};

export type ClaimResult =
  | { readonly ok: true; readonly operationId: Id<"operations">; readonly attemptToken: string }
  | DenialShape;

export type SendArgs = {
  readonly operationId: Id<"operations">;
  readonly token: string;
};

export type SendResult =
  | { readonly ok: true; readonly to: string; readonly payloadHash: string }
  | DenialShape;

export type ResendArgs = {
  readonly operationId: Id<"operations">;
  readonly identity: string;
  readonly newRequestId: string;
};

export type ResendResult =
  | { readonly ok: true; readonly operationId: Id<"operations">; readonly warning: string }
  | DenialShape;

export type ClaimRef = FunctionReference<"mutation", "internal", ClaimArgs, ClaimResult>;
export type SendRef = FunctionReference<"mutation", "internal", SendArgs, SendResult>;
export type ResendRef = FunctionReference<"mutation", "internal", ResendArgs, ResendResult>;

export const claimRef: ClaimRef = runtime.execution.operations.claim;
export const sendRef: SendRef = runtime.execution.communication.recordControlledSend;
export const resendRef: ResendRef = runtime.execution.attempts.reviewedResend;
