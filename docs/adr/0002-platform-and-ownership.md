# ADR-0002: Platform and ownership

Status: Accepted existing platform constraints; deployment proof pending.
Requirements: H-03, H-04, H-06, H-07, D-04, D-09.

## Decision

ChatGPT Sites owns the frontend build, public URL and sharing.
Convex owns durable product records, authorization, business transitions, jobs, schedules, provider coordination and realtime updates.
Use the supported Sites starter at implementation time and keep its hosting contract.
The discarded Vite prototype does not choose the production framework or package versions.
TypeScript is the recommended implementation language for contracts and UI; pin the actual starter/runtime dependencies after the first deployment proof.
Do not add a second application database, standalone application server, generic agent framework, Zustand or TanStack Query without a demonstrated need.

```text
Visitor → Sites React UI → authenticated Convex functions
                              ├─ records and durable workflows
                              ├─ Firecrawl, AgentMail, Jev, OpenAI
                              └─ isolated browser executor
```

The external browser executor is a tool worker, not another owner of project state.
Orca coordinates developers and is not part of the customer's runtime.
The browser receives public deployment configuration, never provider or administrative credentials.

## Module ownership

| Planned area | Owns | Must not own |
| --- | --- | --- |
| `ui/workbench` | Navigation, quote papers, draft inputs and accessible states | Permission or financial truth |
| `convex/access` | Identity, membership, project access and capability checks | Provider SDK behavior |
| `convex/purchasing` | Requirements, evidence, offers, selections and order records | Browser navigation |
| `convex/execution` | Job lifecycle, approvals, reservations and external-effect records | Invented provider success |
| `convex/providers` | Validated translations to current provider APIs | New authority or business rules |
| `browser-executor` | An isolated session and bounded observed operations | Durable customer records or unrestricted actions |

These names assign ownership; do not create forwarding layers or empty modules merely to match the table.
The accepted platform constraints do not approve every proposed module boundary or library choice.

## First proof

After explicit deployment authorization, publish one protected query, one idempotent write and one subscribed UI update.
Run them from the actual `chatgpt.site` origin with the intended hosted Convex deployment.
Capture CSP, CORS, HTTPS and WebSocket failures if present.
Local success does not pass this gate, and a Sites registration is not publication.
Do not build all dependent screens before this connection works.

## Alternatives and consequences

A second full-stack backend would duplicate Convex authority and conflict with the established platform constraint.
A local browser or local Convex deployment cannot power the delivered public experience.
Provider calls may run outside Convex's process, but the authorization, reservation and resulting state remain in Convex.

Sources: [maintained Sites/Convex skill](https://github.com/get-convex/Codex-Sites-Convex-Backend-Skill), [Convex functions](https://docs.convex.dev/functions), [Convex realtime](https://docs.convex.dev/realtime).
The project's installed skill is an instruction source, not proof that the deployment gate has passed.
