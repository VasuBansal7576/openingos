# ADR-0006: Remote browser execution

Status: Proposed; hosted executor and isolation proof are blocking.
Requirements: D-03, D-04, D-05, D-06, D-09, D-10, D-14.

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
Restrict the initial browser proof to read-only navigation and variant inspection.
Form submissions require the same exact-recipient and disclosure grant as email.

## Recovery and handoff

Use the job limits from ADR-0004 and release sessions when waiting for a human or supplier.
Preserve evidence before trying a new method.
When supported interaction fails, try an authorized API, Firecrawl extraction or approved supplier clarification.
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
Capture actual model calls, browser events, timing and cost without publishing cookies or session links.
A local Ultrafast recording does not pass this gate.
