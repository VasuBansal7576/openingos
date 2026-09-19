# ADR-0004: Durable jobs and provider effects

Status: Proposed; integration design specified, controlled and live verification pending.
Requirements: P-05, P-13, P-14, P-17, P-23, D-05, D-06, D-07, D-12, D-13, D-16.
Amended September 19, 2026 after inspecting the sponsor components' source.

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

Proposed starting limits are two active branches per job, 45 browser operations and three consecutive no-progress observations.
Retry ownership and request counts are operation-specific, as defined below.
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

Use the official Firecrawl component for bounded search, map and scrape operations.
Use the official AgentMail component for inbox management, signed webhook ingestion and provider message storage.
Use the existing OpeningOS workflow for outbound AgentMail requests, with one direct REST request per claimed attempt.
Do not use the component's independent outbound queue for this design.
The [sponsor contracts](../integrations/sponsor-contracts.md) define the exact interfaces, configuration, evidence handling and source versions.

The inspected AgentMail source has no application pre-send authorization hook.
Its outbound worker retries independently and its cancellation path can preserve a failed status even when an in-flight request succeeds.
An enqueue-time check alone cannot satisfy our dispatch-time grant and truthful-outcome requirements.
The official component remains useful for inbound mail without making its outbound queue our authority.

Keep a product operation ID and deduplicate callback events before writing quotes or messages.
The inspected send API does not document an idempotency-key contract, so the initial design does not assume one.
Opaque operation labels help reconciliation but do not prevent provider-side duplicates.
Do not claim exactly-once email delivery from a workflow library alone.

An approved communication grant names recipients, permissible disclosures, nonbinding purpose, expiry and round limits.
Covered clarification can proceed without another approval; new recipients or changed authority cannot.
A supplier reply stops obsolete queued follow-ups before dispatch.
Signatures and event IDs, not email subject alone, identify the ingestion route.

## One owner for every retry

| Operation | Retry owner | Required behavior |
| --- | --- | --- |
| Firecrawl search, map or scrape | Firecrawl component inside one reserved operation | Reserve for up to four HTTP attempts; disable automatic workflow retries around the call |
| Firecrawl site-crawl creation | Disabled until its duplicate-start and spending proof passes | Never wrap `startCrawl` in an automatic retry loop |
| AgentMail send or reply | OpeningOS execution module | One HTTP request per claim; workflow step uses `retry: false`; ambiguous results enter reconciliation |
| Model or read-only reconciliation call | OpeningOS execution module | Up to three total attempts, each with current authority and a reservation; no hidden SDK retry multiplier |
| Supplier wait or follow-up timer | Convex Workflow | Suspend, then recheck the latest conversation and grant before proposing another send |

Firecrawl's inspected helper performs an initial request plus up to three retries, including on a lost response.
A reservation covers that entire bounded transport batch as one dispatched operation.
Once dispatched, that batch may finish after cancellation; no new batch may begin.
A strategy change creates a new operation with a new reservation, not a replay of the old operation.
Do not change the upstream retry constant at runtime or edit installed dependency files.

Bulk crawling is not needed to collect many suppliers durably: the OpeningOS workflow can schedule bounded single-page operations and preserve each result.
Enabling `startCrawl` later requires evidence that uncertain starts cannot exceed the reserved cost or lose track of created jobs.
This is a transport choice, not permission to remove the PRD's research or progress requirements.

## Outbound dispatch protocol

1. Save the immutable approved message, exact recipients, grant version, evidence references and payload hash before queuing work.
2. Queue only the operation ID, not a mutable message body or provider credential.
3. In the executing action, call an internal mutation that rechecks authority, current input versions, follow-up stopping conditions and reserved cost.
4. Atomically change `prepared` to `dispatching` and issue one attempt token.
5. Make one bounded REST request with the stored payload and record its validated result through an internal mutation.
6. If the outcome is uncertain, retain the reservation, reconcile through provider reads or signed events, and do not send again automatically.

The atomic claim is the dispatch commitment point, not an atomic transaction with the email provider.
Cancellation before that claim prevents the send.
Cancellation after that claim prevents subsequent work but cannot guarantee that the current message will not be sent.
Record a confirmed late success even when the job is cancelled.
Show job cancellation and message delivery as separate facts.

A duplicate action invocation cannot reclaim an already claimed operation or reuse its attempt token to send again.
If the process dies after claiming, a bounded reconciliation job marks the abandoned attempt `outcomeUnknown`.
An empty provider search is not proof that no message was sent.
After three bounded reconciliation reads, unresolved ambiguity creates a review item while independent research continues.
An explicit reviewed resend creates a linked new operation and warns about the unresolved prior attempt.

## Evidence survives provider housekeeping

OpeningOS stores the approved outbound snapshot before dispatch and records provider receipts and status events independently.
Relevant inbound messages, attachments and web evidence used in a quote receive protected immutable snapshots.
Provider storage is not the sole source of purchasing history.
Missing attachment bytes, truncated pages and unstored crawl pages produce explicit incomplete evidence, never invented completeness.
Component cleanup cannot delete OpeningOS approvals, quote versions, evidence snapshots or operation records.

## Alternatives and acceptance

A synchronous request loop loses work on reload and wastes resources while awaiting replies.
A custom scheduler duplicates an available maintained mechanism.
Using the AgentMail send queue unchanged leaves dispatch-time authorization outside OpeningOS's control.
Maintaining a component fork could add the required hook, but adds upstream maintenance when our chosen workflow already owns the operation state.
The selected direct outbound adapter adds one provider transport, not a second scheduler or another inbox database.

Accept the integration portion after the [worker plan's acceptance cases](../implementation/sponsor-integration-plan.md#acceptance-cases) pass for the pinned installed packages.
Source inspection is not a live test, and no provider integration is implemented by this amendment.

Source evidence: [Firecrawl retry helper at d4056f1](https://github.com/firecrawl/firecrawl-convex/blob/d4056f1e70b6a459ed88df2bb97fa2016816a751/src/component/api.ts), [AgentMail queue and cleanup at 46bde1a](https://github.com/agentmail-to/convex/blob/46bde1a9132599760f425b55c9e29d5ba86ea7df/src/component/lib.ts), [AgentMail callback interface](https://github.com/agentmail-to/convex/blob/46bde1a9132599760f425b55c9e29d5ba86ea7df/src/client/index.ts), [Workflow retry configuration](https://github.com/get-convex/workflow#specifying-retry-behavior).
