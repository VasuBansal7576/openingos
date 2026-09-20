# ADR-0006: Remote browser execution

Status: Accepted for the controlled executor contract; hosted executor, application identity and D-04 remain blocking.
Requirements: D-03, D-04, D-05, D-06, D-09, D-10, D-14.

## September 20, 2026 evidence amendment

The signed job, session binding, operation policy, deadline fencing, callback replay and bounded recovery contracts are accepted as a controlled implementation basis.
The separate Astra review of exact commit `6432e98` closed FR01 through FR08 with no actionable finding after 66 fresh boundary/isolation tests, the prior 64 independent probes and 20 additional 155-test browser-suite repetitions.
All new evidence used synthetic authority, clocks, secrets and injected transport with in-memory sessions.
This partially supports D-05, D-06, D-09, D-10 and D-14 only.
It does not satisfy D-04, hosted isolation, provider credentials, durable shared authority or any real external browser step.

## Recommendation

Use a hosted isolated browser session with a small stateless Jev-guided controller.
Convex creates the job, grants each permitted operation, reserves its cost and accepts independently verified results.
Run the Python/browser controller outside Convex's JavaScript runtime, behind a signed job interface.
Choose the actual compute host after proving connectivity, timeouts, isolation and its spending bound.
Do not install or buy hosting from this draft.

The provider's hosted browser API and the Jev Ultrafast controller are separate pieces.
Browser Use documents remote CDP connections; this does not prove that the current Ultrafast controller works unchanged with that service.
The open-source demo currently uses Browser Harness and a Chrome profile, with limitations including frames, canvas, uploads and popup tabs.
Those limitations make an adaptation test necessary, not a reason to exclude Jev from the product.
Sources checked September 19, 2026: [Ultrafast source and limits](https://github.com/browser-use/jev-ultrafast), [remote browser connections](https://docs.browser-use.com/open-source/customize/browser/remote).

## Contract

```text
BrowserJobRequest {
  jobId, organizationId, projectId, grantVersion, inputVersion,
  allowedOrigins, operationCatalogVersion, sessionLease,
  maximumSteps, expiresAt, reservationId, callbackNonce
}

BrowserObservation {
  jobId, attemptId, observationVersion, url, capturedAt,
  visibleText, observedTargets, collectedEvidence,
  claimedOutcome, verificationEvidence, meteredUsage
}
```

The executor authenticates the signed request and callbacks are authenticated, replay-protected and version-checked.
Opaque session handles and CDP credentials stay server-side.
A session belongs to one organization/project/job authority and expires when its lease ends.
Guest sessions cannot reuse a private user's cookies, storage or recordings.
No browser profile is inherited from the developer's computer.

The allowed target originates in the current observed DOM state.
Before input, check document version, target identity, occlusion and operation effect.
Re-observe if stale; model output never becomes arbitrary selectors, JavaScript, shell commands or URLs to private networks.
Block internal/reserved network ranges, cloud metadata endpoints and unauthorized protocols; validate redirects and destinations too.
Restrict hackathon supplier browsing to read-only navigation and variant inspection.
Disable vendor-facing contact forms, chat messages, RFQ submissions, account creation and purchases in the executor's operation catalog.
The owner-only email restriction cannot be bypassed through browser recovery, another provider or a model-selected tool.
Future launch support for browser outreach requires a separate accepted decision, with exact-recipient and disclosure checks.

## Recovery and handoff

Use the job limits from ADR-0004 and release sessions when waiting for a human or supplier.
Preserve evidence before trying a new method.
When supported interaction fails, try an authorized read-only API or Firecrawl extraction.
An email clarification can go only to the owner acting as supplier and produces controlled demo terms, not verified facts about a real vendor.
CAPTCHA/authentication handling depends on the provider and the site's permitted access; there is no universal bypass promise.
Any necessary user handoff is private, short-lived and bound to the same session and grant.
An unresolved handoff reports waiting, not completed.

## Alternatives

Developer Chrome fails D-04 and isolation requirements.
A hosted opaque agent can provide a fallback, but it cannot establish that Jev selected its internal browser actions.
A custom full browser platform adds substantial maintenance.
Prefer a managed browser with a small controller if the adaptation proof passes; otherwise amend this ADR with the measured fallback and its tradeoffs.

## Acceptance experiment

From a deployed job, inspect a real representative supplier variant using Jev, verify the selected variant independently, interrupt and resume once, and test two simultaneous isolated sessions.
Cancel queued work, expire a lease, replay a callback and attempt a blocked destination.
Attempt vendor contact-form submission and chat through direct and recovery paths; neither may execute.
Capture actual model calls, browser events, timing and cost without publishing cookies or session links.
A local Ultrafast recording does not pass this gate.
