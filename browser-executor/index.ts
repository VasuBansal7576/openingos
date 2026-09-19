// F0-BROWSER controlled contract proof (ADR-0006, proposed).
//
// Controlled proof only: injected transports, synthetic HMAC secrets, frozen
// fixtures. Zero live browser, provider, or network calls; no credentials;
// no claim of D-04 deployed/hosted success, CAPTCHA support, or external
// completion.

export type {
  AttemptState,
  Approval,
  BrowserJobRequest,
  BrowserObservation,
  ClaimedOutcome,
  CollectedEvidence,
  Denial,
  DenialReason,
  Decision,
  JobState,
  MeteredUsage,
  ObservedTarget,
  OperationEffect,
  SessionLeaseSpec,
} from "./types.ts";
export { approved, denied } from "./types.ts";
export {
  MAXIMUM_STEPS_LIMIT,
  parseJobRequest,
  parseObservation,
  parseSessionLease,
} from "./validation.ts";
export {
  SIGNATURE_VERSION,
  canonicalJson,
  createMemoryNonceStore,
  signJobRequest,
  signObservation,
  verifyCallback,
  verifyJobRequest,
} from "./signing.ts";
export type { CallbackAccept, CallbackEnvelope, CallbackResult, NonceStore, SignedJobRequest } from "./signing.ts";
export { createSessionRegistry, isLeaseDecision } from "./sessions.ts";
export type { LeaseContext, LeaseSpec, SessionLease, SessionRegistry } from "./sessions.ts";
export { checkTarget, validateDestination, validateNavigation } from "./policy.ts";
export { OPERATION_CATALOG_VERSION, authorizeOperation, catalogEntries, lookupOperation } from "./operations.ts";
export type { CatalogEntry } from "./operations.ts";
export {
  NON_PROGRESS_LIMIT,
  applyIndependentCheck,
  authorizeStep,
  cancelJob,
  changeStrategy,
  createJob,
  dispatchStep,
  fenceExpired,
  prepareAttempt,
  recordLateObservation,
  settleAttempt,
  tryComplete,
} from "./jobs.ts";
export type {
  AttemptRecord,
  AuthorizeInput,
  BrowserJob,
  CallbackVerifier,
  DispatchReceipt,
  IndependentCheck,
  LateReceipt,
  StepClaim,
  StepOutcome,
  StepTransport,
  TransportInput,
  TransportResult,
  VerifiedOutcome,
} from "./jobs.ts";
