/**
 * F1 owned typed function references (controlled contract).
 *
 * The generated `_generated/api` is stale until official codegen runs
 * (deployment-blocked, F0-owned), but its runtime `internal` object is a
 * dynamic proxy that resolves any registered module path. This hand-written
 * owned helper re-exports that runtime proxy under a precise type built from the actual
 * F1 handler modules with the official `ApiFromModules`/`FilterApi` APIs,
 * so actions can call internal transitions with full type safety and zero
 * assertions. No generated file is edited.
 */

import { anyApi } from "convex/server";
import type { ApiFromModules, FilterApi, FunctionReference } from "convex/server";
import type * as accessCapabilities from "./access/capabilities.js";
import type * as accessGrants from "./access/grants.js";
import type * as accessMemberships from "./access/memberships.js";
import type * as accessRecipients from "./access/recipients.js";
import type * as executionAttempts from "./execution/attempts.js";
import type * as executionCommunication from "./execution/communication.js";
import type * as executionDispatch from "./execution/dispatch.js";
import type * as executionJobs from "./execution/jobs.js";
import type * as executionOperations from "./execution/operations.js";
import type * as executionReconciliation from "./execution/reconciliation.js";
import type * as executionReservations from "./execution/reservations.js";
import type * as purchasingEvidence from "./purchasing/contracts/evidence.js";
import type * as purchasingQuotes from "./purchasing/contracts/quotes.js";

declare const fullF1Api: ApiFromModules<{
  "access/capabilities": typeof accessCapabilities;
  "access/grants": typeof accessGrants;
  "access/memberships": typeof accessMemberships;
  "access/recipients": typeof accessRecipients;
  "execution/attempts": typeof executionAttempts;
  "execution/communication": typeof executionCommunication;
  "execution/dispatch": typeof executionDispatch;
  "execution/jobs": typeof executionJobs;
  "execution/operations": typeof executionOperations;
  "execution/reconciliation": typeof executionReconciliation;
  "execution/reservations": typeof executionReservations;
  "purchasing/contracts/evidence": typeof purchasingEvidence;
  "purchasing/contracts/quotes": typeof purchasingQuotes;
}>;

const runtime: any = anyApi;

export const f1Internal: FilterApi<typeof fullF1Api, FunctionReference<any, "internal">> = runtime;
