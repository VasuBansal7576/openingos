# ADR-0005: Jev-first decisions and OpenAI generation

Status: Proposed; account access, task thresholds and the OpenAI snapshot remain unverified.
Requirements: H-04, D-02, D-03, D-10, D-11, D-12, D-13, D-17.

## Decision

The [Jev integration contract](../integrations/jev-contract.md) specifies the previously missing HTTP endpoint, backend secret, request/response validation, retry owner and J-01 through J-07 proof cases.
The proposed first implementation uses server-side HTTP from a Convex action, with a tested SDK as an explicit alternative rather than a second competing client.
Neither this decision nor a coding-agent subscription supplies TypeSafe application API access.

Make Jev the first route for bounded decisions over observed options.
Use it during collection, not merely after extraction.
Start evaluation with pinned `jev-1.13.0`, which the official model page currently lists, and record the actual returned version.
Do not silently use a moving latest alias after calibrating a policy.
The current model consumes text or structured text, so images and scanned documents need a text or vision-extraction stage first.
Source checked September 19, 2026: [TypeSafe models](https://docs.typesafe.ai/models).

| Work | First owner |
| --- | --- |
| Source relevance, tool choice and research priority | Jev choosing among observed permitted options |
| Browser operation and target | Jev plus freshness and target checks in the executor |
| Message class, missing terms, uncertain variant match | Jev; proposed claims still require evidence checks |
| Clarification/negotiation move and recovery choice | Jev within a current grant and explicit action catalog |
| Commercial extraction, document interpretation, drafting and explanation | OpenAI with schema-validated outputs and source locators |
| Arithmetic, identity checks, mandatory approvals and state transitions | Deterministic application code |

Jev does not fetch a page; the selected tool does.
An LLM does not determine whether a payment, binding acceptance or unrestricted action is allowed.

## Decision contract

Each request includes decision type, question/policy version, job ID, input version, evidence references, observed candidate IDs and permitted option IDs.
Each result records returned model version, choice, probability distribution, confidence, latency, billed usage and the original input version.
Application code validates the output schema, allowed choice and freshness before applying it.
The independent check records what actually happened after execution.
Do not store private chain-of-thought or treat generated rationales as source evidence.

Batch independent questions about the same snapshot.
Keep dependent decisions sequential and discard stale speculative answers.
An unpublished price or sparse website may trigger inquiry or deferral, not permanent rejection.
Deferred suppliers stay visible and can be reconsidered after a fact changes or the user requests more work.

## Thresholds and fallback

Use a policy keyed by decision type, model version, question version and evaluation set.
Confidence is derived from the returned distribution; it is not proof of correctness.
The vendor explicitly recommends risk-dependent thresholds tested on the application domain.
Source: [TypeSafe confidence](https://docs.typesafe.ai/confidence).

Before calibration, run risky classifications in shadow mode and allow only independently checked, reversible read-only choices.
No model confidence permits an unapproved external effect.
Ambiguous scope classification first uses authorized conversation context and a bounded OpenAI classification fallback; unresolved intent gets one focused question or no action.
Clearly unrelated requests stop, without another model trying to fulfill them.
Relevant unknown supplier facts trigger permitted research or clarification before interrupting the user.

Accept numerical thresholds only after measuring false rejections, unauthorized-operation proposals, wrong model matches and incorrectly deferred suitable suppliers.
Do not insert an arbitrary universal 0.9 threshold into worker contracts.
The threshold values and tested OpenAI model snapshot are explicit blockers for dependent execution work, not choices delegated to each worker.

## Documents and answers

Initially support text PDFs, scanned PDFs/images through the selected OpenAI vision route, and the PRD's structured equipment CSV import.
Retain originals, reject unsupported or oversized input with an explanation, and limit pages/bytes by configured allowance.
Never execute macros or document instructions.
An extracted fact is a proposal until its evidence and required review are satisfied.
Answers receive only authorized current records and cached results keyed by their exact versions.
For the live hackathon negotiation, these records include the owner's actual email replies, labeled as controlled counterparty evidence.
Jev chooses from permitted moves and OpenAI extracts or drafts using the latest reply, not a predetermined demonstration transcript.
A provider outage or unreadable reply produces the documented failure or review state, never a fixture presented as a successful model call.
Neither model may invent the owner's next reply or describe an owner-provided price as a confirmed vendor offer.

## Alternatives and acceptance

One general LLM for every choice adds avoidable latency and generative output where a typed choice suffices.
Jev for every task cannot replace text generation, fetching, arithmetic or verified authority.
The chosen division uses each where it removes work.
Measure matched live tasks, including failures, and report Jev decision latency separately from website and supplier wait time.
No speed claim is accepted solely from an upstream demo.
