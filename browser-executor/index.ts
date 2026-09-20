// F0-BROWSER controlled contract proof (ADR-0006, proposed).
//
// Controlled proof only: injected transports, synthetic HMAC secrets, frozen
// fixtures, in-memory authoritative driver state. Zero live browser,
// provider, or network calls; no credentials; no durable transactions,
// hosted sessions, egress isolation, or D-04 deployed/hosted success.

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
  QuarantinedCallback,
  SessionLeaseSpec,
} from "./types.ts";
export { approved, denied, isDenial } from "./types.ts";
export {
  MAXIMUM_STEPS_LIMIT,
  parseJobRequest,
  parseObservation,
  parseRequiredOutputs,
  parseSessionLease,
} from "./validation.ts";
export {
  SIGNATURE_VERSION,
  canonicalJson,
  computeRequestDigest,
  createMemoryNonceStore,
  signJobRequest,
  signObservation,
  verifyCallback,
  verifyJobRequest,
} from "./signing.ts";
export type { CallbackAccept, CallbackEnvelope, CallbackExpectation, CallbackResult, NonceStore, SignedJobRequest } from "./signing.ts";
export { createSessionRegistry, isLeaseDecision } from "./sessions.ts";
export type { LeaseContext, LeaseSpec, SessionLease, SessionRegistry } from "./sessions.ts";
export { checkTarget, validateDestination, validateNavigation } from "./policy.ts";
export { OPERATION_CATALOG_VERSION, authorizeOperation, catalogEntries, lookupOperation } from "./operations.ts";
export type { CatalogEntry } from "./operations.ts";
export {
  NON_PROGRESS_LIMIT,
  QUARANTINE_LIMIT,
  applyIndependentCheck,
  authorizeStep,
  cancelJob,
  changeStrategy,
  createJob,
  fenceExpired,
  prepareAttempt,
  quarantinePolicyRejection,
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
export { ControlledDriver, DEFAULT_STEP_TIMEOUT_MS, ACTIVE_JOB_CEILING_MS, RECONCILIATION_WINDOW_MS } from "./driver.ts";
export type {
  ControlledDriverOptions,
  DriverAuthorizeInput,
  DriverDispatchOptions,
  IssuedClaim,
} from "./driver.ts";
