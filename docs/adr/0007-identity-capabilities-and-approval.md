# ADR-0007: Identity, capabilities and approval

Status: Proposed; identity choice and published-origin behavior need acceptance.
Requirements: P-13, P-15, P-16, P-20, H-06, D-07, D-09, D-14, D-17.

## Recommendation

Use Convex Auth for the hackathon's anonymous evaluation identity and OAuth private identity, subject to an early published-origin proof.
Its Anonymous provider creates an authenticated backend identity without asking the visitor for account details.
Each guest gets a new isolated seeded workspace, not access to shared private records.
Use an established provider rather than inventing guest JWT signing or trusting a client-supplied workspace ID.
Source checked September 19, 2026: [Anonymous provider](https://labs.convex.dev/auth/api_reference/providers/Anonymous).

Clerk is the user's normal managed-auth preference and has an official Convex integration.
Convex Auth is proposed here to handle anonymous guests and private identities through one mechanism, avoiding a second custom guest-security system.
The tradeoff is that Convex Auth remains beta, and server-side framework support needs care.
Keep authenticated customer state client-side for this proof and verify refresh, reload, expiry and OAuth redirects from Sites.
If the proof fails, revisit Clerk plus an established guest mechanism rather than weakening isolation.
Sources: [Convex Auth support and beta status](https://docs.convex.dev/auth/convex-auth), [Clerk integration](https://docs.convex.dev/auth/clerk).

Do not automatically merge a guest workspace into a private account merely because the user signed in.
Claiming a guest project needs proof of control of both sessions and a validated one-time ownership transition.
If that is not implemented, leave the guest sample separate and say so.

## Three independent checks

1. Is the requested product capability shipped and enabled?
2. Can this identity access these records and perform this operation?
3. Does a current job grant authorize this particular external effect?

All must pass in backend code, including direct function calls and queued retries.
The UI and Jev classifier cannot grant authority.
Membership alone does not grant access to every client project.
Every document download, source reference, query and callback follows the same project isolation rules.

## Capability and grant contracts

The reviewed capability catalog defines operation ID, input schema, effect class, required role, allowed tools and outcome verifier.
Effect classes include read, record change, external communication, disclosure, binding commitment and permission change.
The hackathon exposes no binding purchase, payment, financing, contract-signing or service-booking operation.
Unknown operations are denied, including from retrieved instructions or recovery plans.

A grant binds organization, project, approved input versions, recipients, disclosure fields, purpose, allowed operations, cost ceiling, round limit, expiry and revocation version.
Never include private negotiating ceilings in supplier-visible drafts.
An approval binds the exact payload or an explicit bounded communication mandate, not an open-ended "let the agent work."
Recheck access, authority and the mandate before dispatch.
Changed recipients, specifications, quantities, quoted scope or limits invalidate affected queued approvals.

### Owner-only communication constraint

The hackathon capability catalog permits outbound mail only under `communicationProfile: ownerRoleplay`.
The owner supplies one approved mailbox through protected backend configuration; guests, project members and models cannot edit it through application inputs.
Only that address can appear in `To`; CC and BCC remain empty, and incoming `Reply-To` cannot redirect a response.
Both private and guest workspaces obey the restriction, even if a user prompt requests real-vendor outreach.
Bind the recipient configuration version into every communication grant and reject stale versions before dispatch.
Never silently replace a reviewed vendor recipient with the owner after approval.
The approval UI names the owner-as-supplier role and masks the private address for public guests.
Keep project isolation and disclosure checks in force even though multiple conversations share one recipient.
The [sponsor contract](../integrations/sponsor-contracts.md#hackathon-owner-only-communication) defines the remaining recipient and thread checks.

## Scope behavior

Clearly unrelated requests receive a brief refusal and create no execution job or retry.
Unimplemented relevant capabilities are labeled unavailable.
Contextual short follow-ups use the current authorized comparison, rather than a keyword allowlist.
Safely separable mixed requests may complete only the supported portion.
Supplier evidence and attachments are untrusted content and cannot redefine tools or permissions.
Jev helps classify and route uncertainty under ADR-0005; backend allowlists remain authoritative.

## Guest controls and acceptance

Guests can inspect seeded records and perform bounded real research once an owner-funded allowance is configured.
Outbound mail can reach only the owner-designated mailbox, enforced server-side for guests and private sessions alike.
Guest job grants expire, provider sessions are cleaned up, and global rate/spend limits prevent endless new guest sessions bypassing per-user limits.
An unavailable allowance shows a truthful state rather than a fake live run.

Before acceptance, test two guests, two organizations, restricted client projects, forged IDs, stale grants, revoked roles, source-document prompt injection and signed callback replay.
Verify refusal does not cancel a separate legitimate research job.
