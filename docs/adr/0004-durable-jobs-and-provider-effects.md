# ADR-0004: Durable jobs and provider effects

Status: Proposed; provider idempotency and cost bounds need verification.
Requirements: P-05, P-13, P-14, P-17, P-23, D-05, D-06, D-07, D-12, D-13, D-16.

## Decision

Use `@convex-dev/workflow` for durable ordered and parallel steps.
Do not build a second queue system or use an unbounded autonomous loop.
The component documents persisted workflow steps, cancellation and configurable retries; application code still owns business idempotency and external-effect reconciliation.
Source checked September 19, 2026: [Convex Workflow](https://www.convex.dev/components/workflow), [maintained implementation](https://github.com/get-convex/workflow).

```text
startJob(grantId, inputVersions, requestId) → jobId
reserveOperation(jobId, operationId, maximumCost) → reservation or paused
dispatchAuthorizedOperation(reservationId, payloadHash) → attemptId
observeProviderResult(attemptId, providerEventId, result) → validated outcome
cancelJob(jobId) → reject undispatched work, reconcile in-flight work
```

## States and checkpoints

Job states are `queued`, `running`, `waitingForSupplier`, `waitingForUser`, `pausedBudget`, `completed`, `partial`, `failed`, `cancelled`.
Attempts separately record `prepared`, `dispatching`, `observedSuccess`, `observedFailure`, or `outcomeUnknown`.
Keep partial evidence after any terminal job state.
Supplier waits suspend work rather than keeping a browser or model loop alive.
Checkpoint after an observed collection result, accepted extraction, external send result or validated callback.
Completion requires explicit task outputs, not a model's DONE label.

Proposed starting limits are two active branches per job, three transient read attempts per step, 45 browser operations and three consecutive no-progress observations.
Active execution has a 15-minute ceiling; supplier and human waits have their own expiry and do not consume an active browser session.
These are configurable engineering defaults to test, not promises about provider performance.
Never automatically retry an ambiguous external write until its result is reconciled.

## Spend and cancellation

Equipment budget and provider allowance are separate values.
Maintain spent and reserved provider cost in integer micro-USD with a versioned conversion basis for non-USD billing.
An atomic mutation reserves the conservative maximum cost before dispatch.
All branches and retries use the same job allowance and an organization-wide cap.
Reconcile actual cost once; retain a reservation while an outcome or charge is unknown.
If no defensible upper bound fits, pause instead of making the call.
Live allowances default to disabled until the owner approves actual limits.

Dispatch claims recheck cancellation, current access, grant expiry, approved payload and available reservation atomically.
Revocation blocks operations not yet dispatched.
An already dispatched provider request may still complete; cancellation cannot unsend a message.
Reconcile and expose that outcome honestly rather than claiming atomic cancellation across two systems.

## Communication and collection

Prefer the maintained Firecrawl and AgentMail Convex components when their current contracts meet the task.
Before integration, verify send idempotency, webhook signature validation, event identifiers, retry behavior, cancellation and cost reporting against the actual package version.
Keep a product operation ID and deduplicate callback events before writing quotes or messages.
Use provider idempotency keys when supported; otherwise reconcile with recorded provider IDs and stop ambiguous sends for review.
Do not claim exactly-once email delivery from a workflow library alone.

An approved communication grant names recipients, permissible disclosures, nonbinding purpose, expiry and round limits.
Covered clarification can proceed without another approval; new recipients or changed authority cannot.
A supplier reply stops obsolete queued follow-ups before dispatch.
Signatures and event IDs, not email subject alone, identify the ingestion route.

## Alternatives and acceptance

A synchronous request loop loses work on reload and wastes resources while awaiting replies.
A custom scheduler duplicates an available maintained mechanism.
Accept this ADR after duplicate callbacks, provider timeout after send, simultaneous spend reservations, cancellation during execution and a restarted workflow preserve correct state without duplicate effects.

Provider references: [Firecrawl component](https://www.convex.dev/components/firecrawl/firecrawl-convex), [AgentMail component](https://www.convex.dev/components/agentmail/convex).
