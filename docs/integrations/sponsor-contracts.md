# Sponsor integration contracts

Design reference for ADR-0004, checked September 19, 2026.
The interfaces below are planned OpeningOS contracts, not existing functions or evidence of installed integrations.
The companion [worker plan](../implementation/sponsor-integration-plan.md) gives the implementation order and acceptance cases.

## Source baseline and responsibility

| Dependency | Inspected baseline | Selected responsibility |
| --- | --- | --- |
| `@firecrawl/firecrawl-convex` | Source manifest `0.1.1`, commit `d4056f1e70b6a459ed88df2bb97fa2016816a751` | Bounded search, map and scrape; later crawl tracking only after the extra gate |
| `@agentmail/convex` | Source manifest `0.1.0`, commit `46bde1a9132599760f425b55c9e29d5ba86ea7df` | Inbox management, verified webhook ingestion and stored inbound messages |
| `@convex-dev/workflow` | Version not installed or selected yet | Durable OpeningOS jobs, timers and bounded step execution |
| AgentMail REST API | Official send, reply and message-list contracts | One outbound request per authorized attempt; read-only reconciliation |

Source manifest versions are inspection baselines, not proof that an npm artifact has identical contents.
The foundation owner records exact resolved versions, integrity hashes, compatible Convex version and contract-test results in the lockfile and handoff.
The inspected Firecrawl package requires Convex `^1.43.0`.
The inspected AgentMail package declares Convex `^1.24.8` and `convex-helpers` `^0.1.106` as peers.
Neither dependency is installed merely because it appears here.

The coding-agent plugins help development; the component packages and application API credentials power the deployed product.
Connected research tools do not supply application credentials or prove runtime integration.

## Ownership

| Owner | Records and behavior |
| --- | --- |
| Convex application | Project access, capabilities, grants, jobs, operation claims, reservations, purchasing records and evidence |
| Firecrawl component | Provider calls and, when enabled, crawl/page tracking |
| AgentMail component | Provider inbox cache, inbound transport records, signed event ingest and event deduplication |
| OpeningOS communication module | Approved outbound snapshots, REST send attempts, conversation binding, reconciliation and durable delivery history |
| Workflow component | Scheduling, replay and waits, not authority to contact a supplier |
| Sites UI | Authorized queries, user input and display, never provider credentials or permission enforcement |

There is one shared execution module for paid operation claims and reservations.
Research and communication call that module rather than inventing separate budgets or permission checks.
The app does not mirror the entire provider database.
It retains only the transport bindings, bounded UI indexes and evidence needed for the authorized purchasing workflow.

## Configuration contract

Planned registration lives in `convex/convex.config.ts` under one foundation owner.
It registers `firecrawl`, `agentmail` and `workflow` once each using their documented config exports.
Generated `components` references come from Convex code generation, never hand-written declarations.

| Setting | Location | Meaning |
| --- | --- | --- |
| `FIRECRAWL_API_KEY` | Backend secret configuration | Passed through the Firecrawl component's typed environment mapping |
| `FIRECRAWL_WEBHOOK_SECRET` | Backend secret configuration | Required by OpeningOS before enabling webhook-mode crawls, even though upstream makes it optional |
| `AGENTMAIL_API_KEY` | Backend secret configuration | Used by the component and the restricted outbound adapter |
| `AGENTMAIL_WEBHOOK_SECRET` | Backend secret configuration | Required for the verified inbound webhook handler |
| `AGENTMAIL_BASE_URL` | Reviewed backend configuration | One permitted provider origin, never a user-supplied URL |
| Convex client deployment URL | Frontend public configuration | Hosted `.convex.cloud` endpoint; no deployment or admin key |
| Provider allowance | Protected application configuration | Live calls disabled until the owner supplies an explicit allowance |
| `HACKATHON_OWNER_RECIPIENT` | Protected backend configuration | One owner-designated mailbox, never a vendor address from research; no value in Git or frontend configuration |

The AgentMail HTTP handler belongs in `convex/http.ts` at `POST /agentmail/webhook` and delegates signature verification to `agentmail.handleWebhook`.
The actual registered URL uses the backend's public `.convex.site` HTTP origin, not the frontend's `chatgpt.site` URL.
The AgentMail instance used by this route includes `onEvent` and `onMessageReceived` internal-mutation callbacks.
An instance without those callbacks can ingest mail without updating purchasing records.

Firecrawl one-shot collection does not need a webhook.
If bulk crawling passes its gate, `httpPrefix: "/firecrawl/"` mounts the component's own handler.
Its effective backend route is `/firecrawl/webhook`; there is no second hand-written handler for the same path.
A hosted smoke test verifies the effective callback URL rather than assuming local route generation proves reachability.

No keys appear in frontend bundles, request arguments, Git, screenshots or logs.
Test configuration contains variable names and placeholders only.

## Hackathon owner-only communication

This is the user's required hackathon behavior for every workspace, not an optional guest restriction.
The owner plays the supplier and replies manually from their normal email client.
AgentMail sends and receives real messages; live Jev/OpenAI processing and Convex updates use those actual replies.
Research still collects real public vendor information through the approved provider paths.
Only the counterparty's role and commercial terms are controlled for the demonstration.

The communication module owns a single profile, `ownerRoleplay`.
It resolves the recipient from `HACKATHON_OWNER_RECIPIENT` before presenting a draft for approval.
It parses exactly one mailbox using a maintained address parser and preserves its local-part semantics; it does not infer equivalence by stripping dots or plus tags.
The effective outbound payload has exactly that mailbox in `To` and empty `Cc` and `Bcc`.
Both the dispatch claim and transport adapter check this invariant, the approved payload hash and the recipient configuration version.
Missing or invalid configuration blocks dispatch, with no vendor-address fallback.
Changing the setting invalidates queued grants and requires approval against the new version.
An already claimed request follows ADR-0004's in-flight cancellation and reconciliation rules.

Clients and models cannot set recipient headers, select another communication profile or change this backend configuration.
Incoming `Reply-To`, reply-all expansion, new CC addresses, forwarded-message instructions and researched vendor contacts never become destinations.
The application must not send to vendor forms, website chats or another outreach service, including during recovery.
The designated owner mailbox must not be configured to forward these tests to vendors; verify this with the owner before the live proof.
OpeningOS cannot guarantee what a recipient does after receiving an email and must not claim control over downstream forwarding.

An AgentMail project inbox is the application-side sender, distinct from the owner's receiving mailbox.
Multiple scenarios may share the owner recipient, but each thread binds to one project and purchasing conversation.
A matching sender address alone cannot choose a project or quote.
Bind replies through verified inbox/thread/message relationships and the expected counterparty mailbox; quarantine unknown or conflicting messages.
Do not fabricate a reply, auto-generate a supplier counteroffer or run a scripted responder to complete a live demonstration.
If the owner has not replied, show "Waiting for demo supplier" and suspend active execution until a reply, cancellation or the bounded timeout.

The approved snapshot and conversation record carry `communicationProfile`, `recipientConfigVersion`, `counterpartyRole: ownerStandIn` and the actual recipient in protected storage.
An optional `researchedVendorId` is scenario context only; the vendor did not author the owner's reply.
Each evidence record distinguishes `executionMode: live | recorded | fixture` from counterparty role.
Preserve the original live transport trace when presenting a recorded exchange, but never emit that replay as a new inbound event.
Quote versions, calculations, assistant answers and exports inherit the owner-stand-in provenance.
These terms cannot overwrite public vendor prices, stock or genuine supplier performance records.
Display "Live email · Demo supplier" only when live transport is evidenced and "Recorded demo exchange" for replays.
A negotiated delta is a demo improvement, not realized savings or an independently obtained vendor offer.

Approval screens disclose that the recipient is the owner playing the supplier; there is no silent post-approval recipient rewrite.
Public guests receive a role label and redacted message projections, never the owner's address, raw headers or private provider IDs.
Raw messages and attachments stay protected; any guest download needs a redacted derivative or is unavailable.
No credentials, actual recipient address or private reply content enters Git or public verification evidence.
The existing standalone prototype remains a fixture and does not pass these live requirements.

## OpeningOS interfaces

These signatures describe behavior, not a generic provider framework.
The foundation owner maps them to validated Convex functions during F1.
All returned IDs are application IDs; browser callers cannot choose provider inboxes or component rows.

```text
requestResearch(projectId, requirementVersionId, researchIntent, requestId)
  -> jobId
queueInquiry(projectId, grantId, approvedDraftId, requestId)
  -> jobId, operationId
cancelJob(projectId, jobId, requestId)
  -> jobState, unresolvedOperationIds
projectResearch(projectId, pagination)
  -> authorized progress, evidence summaries, continuation
projectConversation(projectId, conversationId, pagination)
  -> authorized message summaries, evidence references, continuation
```

Duplicate requests use the key `(organizationId, operationKind, requestId)` and return the existing operation for an identical normalized payload.
Reusing a key with a different payload returns a conflict and creates no provider call.
Convex mutations enforce this with indexed reads and writes in the same transaction; an index alone is not a uniqueness constraint.

Internal interfaces include `claimOperation`, `recordProviderOutcome`, `ingestMailEvent`, `acceptResearchEvidence` and `reconcileOperation`.
`claimOperation` returns either a typed denial or a single-use attempt token with the immutable payload and reservation reference.
It loads current membership, project permission, capability, grant, input version, conversation state and cost reservation itself.
No worker passes an unchecked `authorized: true` flag.

The public result variants distinguish permission denial, stale input, unavailable integration, exhausted allowance and waiting for review.
Provider errors are mapped to these domain results without exposing credentials or raw private response bodies.

## Shared records and keys

| Logical record | Required fields and invariant |
| --- | --- |
| Provider binding | Provider, environment, organization, project, provider object ID and application object ID; binding is assigned server-side |
| Operation | Job, kind, input versions, approved payload hash, grant version, request key, reservation and dispatch state |
| Attempt | Operation, unique attempt token, claim time, response facts and reconciliation state |
| Reservation | Integer maximum cost, pricing basis, request multiplicity, spent amount and unresolved charge amount |
| Processed event | Provider, environment, stable event ID, processing version and outcome; duplicate callback has no second product effect |
| Evidence snapshot | Source kind, provider IDs or URL, capture time, hash, protected storage reference, completeness and provenance |
| Outbound snapshot | Approved recipients, recipient configuration version, communication profile, counterparty role, body, attachment hashes, grant, purpose and input versions, saved before dispatch |

Physical table names are selected by F1 and then frozen for dependent workers.
These fields must not be silently omitted or split into incompatible worker-specific schemas.
Provider IDs are opaque and never serve as authorization credentials.
The initial mail design assigns an inbox to one project; a thread is bound to one purchasing conversation within that project.
F0 starts with known controlled inboxes bound by the coordinator, not arbitrary automatic inbox creation.
Any later inbox-creation operation needs its own authority and reconciliation contract before retries are enabled.
An unknown inbox or conflicting thread binding is quarantined, not routed by subject, sender display name or a model guess.

## Firecrawl collection

The research adapter calls the official `FirecrawlClient.search`, `map` and `scrape` from internal actions after the execution claim.
An allowed operation fixes query or URL, result limit, requested formats, freshness and permitted origin policy before dispatch.
Arbitrary provider `extra` fields and raw browser-supplied options are not exposed.

At the inspected revision, the transport can issue four HTTP attempts per call.
The reservation therefore covers four maximum-priced attempts, including optional extraction or search-result scraping charges if those are enabled.
The surrounding workflow step disables automatic retries.
Unknown pricing or an unsupported bound prevents dispatch instead of treating the request as free.
Cached evidence reuse still checks organization access and the original capture time.

Responses are parsed from `unknown` into the narrow fields the application needs.
TypeScript annotations in a dependency are not runtime validation of supplier facts.
A captured claim identifies its URL, fetch time, exact product variant, field locator and source bytes or excerpt.
Jev prioritization cannot turn a missing field into a verified claim.

Evidence completeness is `complete`, `partial` or `unavailable`, separate from whether an individual supported claim is verified.
Complete describes the captured source payload, not the whole website or supplier market.
The component's `truncated` flag and crawl `unstored` count are preserved in the product projection.
A partial source may support an exact visible fact but cannot prove that an omitted condition does not exist.
For a decision-critical missing vendor fact, use a bounded targeted fetch or user review and retain unknown when the fact remains unsupported.
An inquiry to the owner can supply controlled demo terms but cannot verify a real vendor's missing commercial terms.
The original incomplete record remains in history.

`startCrawl` is not enabled in the initial adapter.
Its inspected start path can retry a POST after a lost response, so a single returned crawl ID is not proof of a single provider job.
The foundation owner must prove safe start reconciliation, total cost bounds, callback ownership and cancellation before enabling it.
Until then, multi-page research uses saved workflow steps over bounded one-shot operations.

## Outbound AgentMail transport

Only the communication adapter can call AgentMail's send and reply endpoints.
The exact route forms are `POST /v0/inboxes/{inbox_id}/messages/send` and `POST /v0/inboxes/{inbox_id}/messages/{message_id}/reply`.
The adapter uses a fixed allowed origin, encoded provider IDs, a timeout, response-size limits, no redirect following and no automatic transport retries.
The executing action claims the operation immediately before the HTTP call, as specified in ADR-0004.

Both endpoints return a provider `message_id` and `thread_id` on a documented successful response.
The adapter validates those values before recording confirmed acceptance by AgentMail.
Acceptance by the provider is displayed as sent, never as delivered to the recipient without delivery evidence.
Malformed success responses, transport failures and unclassified server errors after dispatch produce `outcomeUnknown`.
Only an allowlisted, documented no-effect rejection may produce `observedFailure` without reconciliation.

Reply recipients are resolved and checked explicitly, including CC and BCC.
`reply_all` and implicit recipients are disabled for the first adapter.
Thread context is not permission to disclose more information or contact a new address.
Models cannot set arbitrary headers, tracking flags, attachment URLs or a provider base URL.

An opaque operation label is included for reconciliation without disclosing project IDs or private financial limits.
The label is correlation data, not an idempotency key.
Reconciliation reads the correct inbox with bounded pagination and validates candidate message IDs, recipients and payload evidence.
A provider-list result with the same subject is insufficient to confirm a match.
Late or early signed events are retained until their operation binding can be resolved.
No automatic resend follows an empty or inconclusive search.

## Incoming mail and event processing

The official component verifies the signed request and deduplicates provider event IDs before invoking application callbacks.
The callbacks remain internal mutations and validate their payloads before product changes.
`onMessageReceived` owns received-message processing; `onEvent` owns delivery and other transport events and must not process the same inbound message a second time.

Each callback resolves the server-side inbox and conversation binding, then atomically records its product-event key and schedules permitted follow-on work.
Receipt of a bound supplier reply advances the conversation version and suspends pending follow-ups before model classification runs.
Only a current classified result may resume an appropriate follow-up under the original grant.
The application also deduplicates quote extraction by provider message ID, source content hash and extraction version.
Two different event IDs referring to the same message must not create duplicate quote revisions.
Callback retries cannot spend provider credits or send mail directly from a mutation.
They create or resume an authorized workflow operation instead.

The raw event record and its product-processing outcome remain distinct.
A failed model extraction does not require replaying the provider webhook to recover the message.
Reprocessing uses the preserved source and a new processing version.
An accepted callback records pending ingestion and schedules processing atomically, so a later extraction failure has a durable repair target.
For a callback that never commits, a bounded reconciliation read compares the known conversation's provider messages with application message IDs and imports missing sources through the same validated interface.
That read consumes an explicit reservation and cannot bypass a paused allowance.
Recovery does not depend on resubmitting a webhook that the component has already deduplicated.
Unknown or conflicting delivery events are retained with a reconciliation marker rather than overwriting a later confirmed state.

App-owned paginated conversation summaries drive the UI.
The component's unbounded thread collection is not exposed as a public bulk query.
Original message and attachment access uses the same project authorization as the quote.
Supplier HTML is untrusted and rendered as sanitized content or plain text.

## Evidence lifetime

The inspected AgentMail component removes finalized outbound rows after seven days.
That cleanup is not OpeningOS's purchasing-history retention policy.
The selected design does not enqueue outgoing messages into those rows.
OpeningOS stores its own approved outgoing snapshot, response IDs and delivery-event history from the start.

Incoming correspondence and attachments used by a purchasing decision receive immutable protected snapshots with hashes.
An attachment metadata row or expiring provider URL does not count as preserved bytes.
Missing or oversized bytes produce an incomplete evidence state and a bounded recovery path.
Downloads recheck project access and use private storage with short-lived authorized access.

No provider cache expiry or component housekeeping deletes a retained project decision or its necessary evidence.
Explicit project deletion and future retention policy are separate controlled operations, not enabled by this document.
This is not a promise of permanent storage or a legal retention period.

## Source references

- [Firecrawl source and setup at the inspected revision](https://github.com/firecrawl/firecrawl-convex/tree/d4056f1e70b6a459ed88df2bb97fa2016816a751).
- [Firecrawl transport retry behavior](https://github.com/firecrawl/firecrawl-convex/blob/d4056f1e70b6a459ed88df2bb97fa2016816a751/src/component/api.ts).
- [Firecrawl crawl creation and page storage](https://github.com/firecrawl/firecrawl-convex/blob/d4056f1e70b6a459ed88df2bb97fa2016816a751/src/component/crawl.ts).
- [AgentMail source and setup at the inspected revision](https://github.com/agentmail-to/convex/tree/46bde1a9132599760f425b55c9e29d5ba86ea7df).
- [AgentMail outbound queue, callbacks and cleanup](https://github.com/agentmail-to/convex/blob/46bde1a9132599760f425b55c9e29d5ba86ea7df/src/component/lib.ts).
- [AgentMail send API](https://docs.agentmail.to/api-reference/inboxes/messages/send), [reply API](https://docs.agentmail.to/api-reference/inboxes/messages/reply), [message-list API](https://docs.agentmail.to/api-reference/inboxes/messages/list).
- [Convex component registration, transactions and HTTP routes](https://docs.convex.dev/components/using).
- [Workflow retry configuration](https://github.com/get-convex/workflow#specifying-retry-behavior).
