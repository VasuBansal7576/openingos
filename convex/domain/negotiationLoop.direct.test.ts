/**
 * E6 controlled negotiation policy/adapter contract tests (P-05 / P-23,
 * controlled D-12, controlled J-06 extension; supports P-13 / P-17).
 *
 * Pure vitest boundary tests only: every provider/model outcome is an
 * injected controlled value, the sender is an in-memory controlled stub
 * mirroring the `communication/send:dispatch` result shape, and no live
 * transport, model call, or email send is ever invoked. `fetch` is left
 * unstubbed so any attempted live call would throw instead of succeeding.
 */

import { describe, expect, test } from "vitest";
import { JEV_PINNED_MODEL } from "../../proofs/jev/jev-boundary.js";
import {
  applyControlledDispatchOutcome,
  checkNegotiationBounds,
  checkNegotiationFences,
  deduplicateNegotiationRetry,
  E6_NEGOTIATION_CORPUS,
  E6_NEGOTIATION_CORPUS_VERSION,
  NEGOTIATION_LOOP_VERSION,
  NEGOTIATION_MOVES,
  NEGOTIATION_OPENAI_MODEL,
  NEGOTIATION_OPERATION_KIND,
  NEGOTIATION_SUBJECT,
  redactForProjection,
  runNegotiationStep,
  scoreE6NegotiationCorpus,
  selectNegotiationMove,
  validateControlledDispatchResult,
  validateNegotiationDraft,
  type ControlledDispatchResult,
  type ControlledNegotiationSender,
  type InjectedDraftResult,
  type InjectedJevResult,
  type MandateSnapshot,
  type NegotiationCurrentSnapshot,
  type NegotiationStepInput,
} from "./negotiationLoop.js";

const OWNER_MAILBOX = "owner-demo@example.invalid";

function mandate(overrides: Partial<MandateSnapshot> = {}): MandateSnapshot {
  return {
    negotiationId: "neg-e6-1",
    organizationId: "org-e6",
    projectId: "proj-e6",
    quoteId: "quote-e6",
    state: "active",
    quoteVersion: "qv-3",
    quoteContentHash: "hash-qv-3",
    conversationId: "conv-e6",
    conversationVersion: 4,
    roundsUsed: 1,
    roundLimit: 3,
    targetMinorUnits: 750000,
    ceilingMinorUnits: 795000,
    expiresAt: 2_000_000,
    ...overrides,
  };
}

function current(overrides: Partial<NegotiationCurrentSnapshot> = {}): NegotiationCurrentSnapshot {
  return {
    now: 1_000_000,
    currentQuoteId: "quote-e6",
    quoteVersion: "qv-3",
    quoteContentHash: "hash-qv-3",
    quoteSuperseded: false,
    currentConversationId: "conv-e6",
    conversationVersion: 4,
    jobState: "running",
    jobCancelled: false,
    grantStatus: "active",
    grantExpiresAt: 2_000_000,
    currentGrantId: "grant-e6",
    operationGrantId: "grant-e6",
    grantRevocationVersion: 1,
    operationGrantVersion: 1,
    recipientConfigured: true,
    recipientConfigVersion: 7,
    currentRecipientConfigVersion: 7,
    recipientMailboxNormalized: OWNER_MAILBOX,
    allowanceExhausted: false,
    userTakeover: false,
    finalOfferReceived: false,
    ...overrides,
  };
}

function jev(overrides: Partial<InjectedJevResult> = {}): InjectedJevResult {
  return {
    outcome: "decided",
    choice: "clarify",
    model: JEV_PINNED_MODEL,
    inputVersion: "e6-input-v1",
    currentInputVersion: "e6-input-v1",
    ...overrides,
  };
}

function draft(overrides: Partial<InjectedDraftResult> = {}): InjectedDraftResult {
  return {
    outcome: "completed",
    draftKind: "clarify",
    content: "Could you confirm whether freight and installation are included in the quoted total?",
    sourceQuoteVersion: "qv-3",
    sourceConversationVersion: 4,
    model: NEGOTIATION_OPENAI_MODEL,
    inputVersion: "e6-input-v1",
    currentInputVersion: "e6-input-v1",
    ...overrides,
  };
}

function controlledSuccess(overrides: Partial<Extract<ControlledDispatchResult, { ok: true }>> = {}): ControlledDispatchResult {
  return {
    ok: true,
    outcome: "success",
    providerMessageId: "msg-controlled-1",
    providerThreadId: "thread-controlled-1",
    recorded: true,
    ...overrides,
  };
}

function stubSender(result: ControlledDispatchResult = controlledSuccess()): {
  sender: ControlledNegotiationSender;
  calls: () => number;
  lastCanonical: () => string | null;
} {
  let calls = 0;
  let lastCanonical: string | null = null;
  return {
    calls: () => calls,
    lastCanonical: () => lastCanonical,
    sender: {
      executionMode: "controlled",
      send: (payload) => {
        calls += 1;
        lastCanonical = payload.canonical;
        return result;
      },
    },
  };
}

function stepInput(overrides: Partial<NegotiationStepInput> = {}): NegotiationStepInput {
  const stub = stubSender();
  return {
    mandate: mandate(),
    current: current(),
    jev: jev(),
    draft: draft(),
    requestId: "req-e6-1",
    prior: null,
    sender: stub.sender,
    ...overrides,
  };
}

describe("E6 permitted move selection", () => {
  test("selects each permitted clarify/counter/hold/stop move from a current decided Jev result", () => {
    for (const move of NEGOTIATION_MOVES) {
      const selected = selectNegotiationMove(jev({ choice: move }));
      expect(selected.ok).toBe(true);
      if (selected.ok) expect(selected.move).toBe(move);
    }
  });

  test("clarify move with a valid draft sends once through the controlled sender and increments rounds", () => {
    const stub = stubSender();
    const result = runNegotiationStep(stepInput({ sender: stub.sender }));
    expect(result.kind).toBe("sent");
    expect(result.sends).toBe(1);
    expect(result.dispatchAttempts).toBe(1);
    expect(stub.calls()).toBe(1);
    expect(stub.sender.executionMode).toBe("controlled");
    if (result.kind === "sent") {
      expect(result.move).toBe("clarify");
      expect(result.roundsUsedAfter).toBe(2);
      expect(result.requestKey).toContain("org-e6");
      expect(result.payloadHash).toMatch(/^[0-9a-f]{16}$/);
      expect(result.lineage.executionMode).toBe("controlled");
      expect(result.lineage.counterpartyRole).toBe("ownerStandIn");
      expect(result.lineage.quoteVersion).toBe("qv-3");
      expect(result.lineage.conversationVersion).toBe(4);
      expect(result.lineage.operationKind).toBe(NEGOTIATION_OPERATION_KIND);
      expect(result.lineage.sendState).toBe("observedSuccess");
      expect(result.lineage.providerMessageId).toBe("msg-controlled-1");
      expect(result.lineage.providerThreadId).toBe("thread-controlled-1");
      expect(result.lineage.dispatchAttempts).toBe(1);
      expect(result.lineage.evidenceLabel).toContain("never realized savings");
    }
  });

  test("counter move sends with the same honest lineage", () => {
    const stub = stubSender();
    const result = runNegotiationStep(
      stepInput({ sender: stub.sender, jev: jev({ choice: "counter" }), draft: draft({ draftKind: "counter" }) }),
    );
    expect(result.kind).toBe("sent");
    if (result.kind === "sent") {
      expect(result.move).toBe("counter");
      expect(result.roundsUsedAfter).toBe(2);
    }
  });

  test("dispatched payload uses the fixed server-derived subject", () => {
    const stub = stubSender();
    const result = runNegotiationStep(stepInput({ sender: stub.sender }));
    expect(result.kind).toBe("sent");
    const canonical = stub.lastCanonical();
    expect(canonical).not.toBe(null);
    const parsed: unknown = JSON.parse(canonical ?? "");
    expect((parsed as Record<string, unknown>)["subject"]).toBe(NEGOTIATION_SUBJECT);
  });
});

describe("E6 malformed and disallowed Jev answers", () => {
  test("missing choice denies with zero sends", () => {
    const stub = stubSender();
    const noChoice: InjectedJevResult = {
      outcome: "decided",
      model: JEV_PINNED_MODEL,
      inputVersion: "e6-input-v1",
      currentInputVersion: "e6-input-v1",
    };
    const result = runNegotiationStep(stepInput({ sender: stub.sender, jev: noChoice }));
    expect(result.kind).toBe("denied");
    if (result.kind === "denied") expect(result.code).toBe("jev-malformed");
    expect(result.sends).toBe(0);
    expect(result.dispatchAttempts).toBe(0);
    expect(stub.calls()).toBe(0);
  });

  test("disallowed choice denies with zero sends", () => {
    const stub = stubSender();
    const result = runNegotiationStep(stepInput({ sender: stub.sender, jev: jev({ choice: "accept" }) }));
    expect(result.kind).toBe("denied");
    if (result.kind === "denied") expect(result.code).toBe("jev-malformed");
    expect(result.sends).toBe(0);
    expect(stub.calls()).toBe(0);
  });

  test("wrong model version denies with zero sends", () => {
    const stub = stubSender();
    const result = runNegotiationStep(stepInput({ sender: stub.sender, jev: jev({ model: "jev-latest" }) }));
    expect(result.kind).toBe("denied");
    if (result.kind === "denied") expect(result.code).toBe("jev-malformed");
    expect(result.sends).toBe(0);
    expect(stub.calls()).toBe(0);
  });

  test("stale Jev input version waits with zero sends", () => {
    const stub = stubSender();
    const result = runNegotiationStep(
      stepInput({ sender: stub.sender, jev: jev({ inputVersion: "e6-input-v0" }) }),
    );
    expect(result.kind).toBe("waiting");
    if (result.kind === "waiting") expect(result.reason).toBe("jev-stale");
    expect(result.sends).toBe(0);
    expect(stub.calls()).toBe(0);
  });

  test("needsReview and unavailable Jev outcomes wait with zero sends", () => {
    for (const outcome of ["needsReview", "unavailable"] as const) {
      const stub = stubSender();
      const result = runNegotiationStep(stepInput({ sender: stub.sender, jev: jev({ outcome }) }));
      expect(result.kind).toBe("waiting");
      expect(result.sends).toBe(0);
      expect(stub.calls()).toBe(0);
    }
  });
});

describe("E6 exact current basis", () => {
  test("changed current quote id stops with zero sends", () => {
    const stub = stubSender();
    const result = runNegotiationStep(
      stepInput({ sender: stub.sender, current: current({ currentQuoteId: "quote-other" }) }),
    );
    expect(result.kind).toBe("stopped");
    if (result.kind === "stopped") expect(result.reason).toBe("quote-changed");
    expect(result.sends).toBe(0);
    expect(stub.calls()).toBe(0);
  });

  test("missing current quote id stops with zero sends", () => {
    const { currentQuoteId: _droppedQuoteId, ...missing } = current();
    void _droppedQuoteId;
    const result = runNegotiationStep(stepInput({ current: missing }));
    expect(result.kind).toBe("stopped");
    if (result.kind === "stopped") expect(result.reason).toBe("quote-changed");
    expect(result.sends).toBe(0);
  });

  test("mandate-bound conversation with missing current id stops", () => {
    const { currentConversationId: _droppedConversationId, ...missing } = current();
    void _droppedConversationId;
    const result = runNegotiationStep(stepInput({ current: missing }));
    expect(result.kind).toBe("stopped");
    if (result.kind === "stopped") expect(result.reason).toBe("conversation-changed");
    expect(result.sends).toBe(0);
  });

  test("mandate-bound conversation with missing current version stops", () => {
    const { conversationVersion: _droppedVersion, ...missing } = current();
    void _droppedVersion;
    const result = runNegotiationStep(stepInput({ current: missing }));
    expect(result.kind).toBe("stopped");
    if (result.kind === "stopped") expect(result.reason).toBe("conversation-changed");
    expect(result.sends).toBe(0);
  });

  test("mandate-bound conversation with a different current id stops", () => {
    const result = runNegotiationStep(stepInput({ current: current({ currentConversationId: "conv-other" }) }));
    expect(result.kind).toBe("stopped");
    if (result.kind === "stopped") expect(result.reason).toBe("conversation-changed");
    expect(result.sends).toBe(0);
  });

  test("unbound mandate does not silently accept a newly bound current conversation", () => {
    const { conversationId: _droppedId, conversationVersion: _droppedVersion, ...freeRest } = mandate();
    void _droppedId;
    void _droppedVersion;
    const free: MandateSnapshot = freeRest;
    const boundId = runNegotiationStep(stepInput({ mandate: free, current: current({ currentConversationId: "conv-new" }) }));
    expect(boundId.kind).toBe("stopped");
    if (boundId.kind === "stopped") expect(boundId.reason).toBe("conversation-changed");
    expect(boundId.sends).toBe(0);

    const { currentConversationId: _droppedCurrentId, conversationVersion: _droppedCurrentVersion, ...clearRest } = current();
    void _droppedCurrentId;
    void _droppedCurrentVersion;
    const versionOnly: NegotiationCurrentSnapshot = { ...clearRest, conversationVersion: 9 };
    const withVersion = runNegotiationStep(stepInput({ mandate: free, current: versionOnly }));
    expect(withVersion.kind).toBe("stopped");
    expect(withVersion.sends).toBe(0);
  });

  test("unbound mandate with unbound current proceeds", () => {
    const stub = stubSender();
    const { conversationId: _freeId, conversationVersion: _freeVersion, ...freeRest } = mandate();
    void _freeId;
    void _freeVersion;
    const free: MandateSnapshot = freeRest;
    const { currentConversationId: _clearId, conversationVersion: _clearVersion, ...clearRest } = current();
    void _clearId;
    void _clearVersion;
    const clear: NegotiationCurrentSnapshot = clearRest;
    const { sourceConversationVersion: _droppedPin, ...draftRest } = draft();
    void _droppedPin;
    const unpinned: InjectedDraftResult = draftRest;
    const result = runNegotiationStep(
      stepInput({ sender: stub.sender, mandate: free, current: clear, draft: unpinned }),
    );
    expect(result.kind).toBe("sent");
    expect(result.sends).toBe(1);
  });
});

describe("E6 exact draft basis", () => {
  test("missing source quote pin denies with zero dispatch", () => {
    const stub = stubSender();
    const { sourceQuoteVersion: _droppedPin, ...missingRest } = draft();
    void _droppedPin;
    const missing: InjectedDraftResult = missingRest;
    const result = runNegotiationStep(stepInput({ sender: stub.sender, draft: missing }));
    expect(result.kind).toBe("denied");
    if (result.kind === "denied") expect(result.code).toBe("draft-malformed");
    expect(result.sends).toBe(0);
    expect(result.dispatchAttempts).toBe(0);
    expect(stub.calls()).toBe(0);
  });

  test("mismatched source quote pin waits with zero dispatch", () => {
    const stub = stubSender();
    const result = runNegotiationStep(
      stepInput({ sender: stub.sender, draft: draft({ sourceQuoteVersion: "qv-2" }) }),
    );
    expect(result.kind).toBe("waiting");
    if (result.kind === "waiting") expect(result.reason).toBe("draft-stale");
    expect(result.sends).toBe(0);
    expect(result.dispatchAttempts).toBe(0);
    expect(stub.calls()).toBe(0);
  });

  test("mandate conversation requires an exact conversation pin", () => {
    const { sourceConversationVersion: _droppedConvPin, ...missingRest } = draft();
    void _droppedConvPin;
    const missing: InjectedDraftResult = missingRest;
    const deniedResult = runNegotiationStep(stepInput({ draft: missing }));
    expect(deniedResult.kind).toBe("denied");
    if (deniedResult.kind === "denied") expect(deniedResult.code).toBe("draft-malformed");
    expect(deniedResult.dispatchAttempts).toBe(0);

    const stale = runNegotiationStep(stepInput({ draft: draft({ sourceConversationVersion: 3 }) }));
    expect(stale.kind).toBe("waiting");
    if (stale.kind === "waiting") expect(stale.reason).toBe("draft-stale");
    expect(stale.dispatchAttempts).toBe(0);
  });

  test("conversation-bound draft against a conversation-free mandate waits", () => {
    const { conversationId: _mandateId, conversationVersion: _mandateVersion, ...freeRest } = mandate();
    void _mandateId;
    void _mandateVersion;
    const free: MandateSnapshot = freeRest;
    const { currentConversationId: _currentId, conversationVersion: _currentVersion, ...clearRest } = current();
    void _currentId;
    void _currentVersion;
    const clear: NegotiationCurrentSnapshot = clearRest;
    const result = runNegotiationStep(stepInput({ mandate: free, current: clear, draft: draft() }));
    expect(result.kind).toBe("waiting");
    if (result.kind === "waiting") expect(result.reason).toBe("draft-stale");
    expect(result.sends).toBe(0);
    expect(result.dispatchAttempts).toBe(0);
  });

  test("draft kind must exactly equal the selected move", () => {
    const { draftKind: _droppedKind, ...missingRest } = draft();
    void _droppedKind;
    const missing: InjectedDraftResult = missingRest;
    const noKind = runNegotiationStep(stepInput({ draft: missing }));
    expect(noKind.kind).toBe("denied");
    if (noKind.kind === "denied") expect(noKind.code).toBe("draft-malformed");
    expect(noKind.dispatchAttempts).toBe(0);

    const other = runNegotiationStep(stepInput({ draft: draft({ draftKind: "counter" }) }));
    expect(other.kind).toBe("denied");
    if (other.kind === "denied") expect(other.code).toBe("draft-malformed");
    expect(other.dispatchAttempts).toBe(0);
  });
});

describe("E6 disclosure redaction", () => {
  test("draft leaking the confidential target figure is denied with zero sends", () => {
    const stub = stubSender();
    const result = runNegotiationStep(
      stepInput({
        sender: stub.sender,
        draft: draft({ content: "Our walk-away target is 750000 internally." }),
      }),
    );
    expect(result.kind).toBe("denied");
    if (result.kind === "denied") expect(result.code).toBe("draft-disclosure-leak");
    expect(result.sends).toBe(0);
    expect(stub.calls()).toBe(0);
  });

  test("draft leaking the ceiling as a major-units amount is denied", () => {
    const checked = validateNegotiationDraft("We can stretch to 7950.00 if needed.", {
      ceilingMinorUnits: 795000,
    });
    expect(checked.ok).toBe(false);
  });

  test("grouped and European figure renderings fail closed", () => {
    expect(validateNegotiationDraft("We can do 7,500 flat.", { targetMinorUnits: 750000 }).ok).toBe(false);
    expect(validateNegotiationDraft("We can do 7.500,00 flat.", { targetMinorUnits: 750000 }).ok).toBe(false);
    expect(validateNegotiationDraft("Ceiling 7950 confirmed.", { ceilingMinorUnits: 795000 }).ok).toBe(false);
  });

  test("draft leaking the private owner mailbox is denied", () => {
    const checked = validateNegotiationDraft(`Please reply to ${OWNER_MAILBOX} soon.`, {
      ownerMailboxNormalized: OWNER_MAILBOX,
    });
    expect(checked.ok).toBe(false);
    if (!checked.ok) expect(checked.code).toBe("draft-disclosure-leak");
  });

  test("public projections never carry the mailbox or confidential figures", () => {
    const preview = redactForProjection(`Contact ${OWNER_MAILBOX} about freight.`);
    expect(preview).not.toContain(OWNER_MAILBOX);
    expect(preview).toContain("[redacted-mailbox]");
    const stub = stubSender();
    const result = runNegotiationStep(stepInput({ sender: stub.sender }));
    if (result.kind === "sent") {
      expect(result.lineage.redactedPreview).not.toContain(OWNER_MAILBOX);
      expect(JSON.stringify(result.lineage)).not.toContain(OWNER_MAILBOX);
      expect(JSON.stringify(result.lineage)).not.toContain("750000");
      expect(JSON.stringify(result.lineage)).not.toContain("795000");
    } else {
      throw new Error("expected sent lineage for redaction probe");
    }
  });
});

describe("E6 quote and conversation change stops", () => {
  test("changed quote version stops with zero sends", () => {
    const stub = stubSender();
    const result = runNegotiationStep(
      stepInput({ sender: stub.sender, current: current({ quoteVersion: "qv-4", quoteContentHash: "hash-qv-4" }) }),
    );
    expect(result.kind).toBe("stopped");
    if (result.kind === "stopped") expect(result.reason).toBe("quote-changed");
    expect(result.sends).toBe(0);
    expect(stub.calls()).toBe(0);
  });

  test("superseded quote stops with zero sends", () => {
    const stub = stubSender();
    const result = runNegotiationStep(
      stepInput({ sender: stub.sender, current: current({ quoteSuperseded: true }) }),
    );
    expect(result.kind).toBe("stopped");
    if (result.kind === "stopped") expect(result.reason).toBe("quote-superseded");
    expect(result.sends).toBe(0);
    expect(stub.calls()).toBe(0);
  });

  test("changed conversation version stops with zero sends", () => {
    const stub = stubSender();
    const result = runNegotiationStep(
      stepInput({ sender: stub.sender, current: current({ conversationVersion: 5 }) }),
    );
    expect(result.kind).toBe("stopped");
    if (result.kind === "stopped") expect(result.reason).toBe("conversation-changed");
    expect(result.sends).toBe(0);
    expect(stub.calls()).toBe(0);
  });
});

describe("E6 mandate expiry, revocation, and terminal stops", () => {
  test("expired mandate stops with zero sends", () => {
    const stub = stubSender();
    const result = runNegotiationStep(
      stepInput({ sender: stub.sender, current: current({ now: 3_000_000 }) }),
    );
    expect(result.kind).toBe("stopped");
    if (result.kind === "stopped") expect(result.reason).toBe("mandate-expired");
    expect(result.sends).toBe(0);
    expect(stub.calls()).toBe(0);
  });

  test("revoked and concluded mandates stop with zero sends", () => {
    for (const [state, reason] of [
      ["revoked", "mandate-revoked"],
      ["concluded", "mandate-concluded"],
    ] as const) {
      const stub = stubSender();
      const result = runNegotiationStep(stepInput({ sender: stub.sender, mandate: mandate({ state }) }));
      expect(result.kind).toBe("stopped");
      if (result.kind === "stopped") expect(result.reason).toBe(reason);
      expect(result.sends).toBe(0);
      expect(stub.calls()).toBe(0);
    }
  });

  test("paused mandate waits honestly with zero sends", () => {
    const stub = stubSender();
    const result = runNegotiationStep(stepInput({ sender: stub.sender, mandate: mandate({ state: "paused" }) }));
    expect(result.kind).toBe("waiting");
    if (result.kind === "waiting") expect(result.reason).toBe("mandate-paused");
    expect(result.sends).toBe(0);
    expect(stub.calls()).toBe(0);
  });

  test("round limit, final offer, and user takeover stop with zero sends", () => {
    const stoppedCases: Array<{ name: string; input: Partial<NegotiationStepInput> }> = [
      { name: "round-limit", input: { mandate: mandate({ roundsUsed: 3 }) } },
      { name: "final-offer", input: { current: current({ finalOfferReceived: true }) } },
      { name: "user-takeover", input: { current: current({ userTakeover: true }) } },
    ];
    for (const probe of stoppedCases) {
      const stub = stubSender();
      const result = runNegotiationStep(stepInput({ sender: stub.sender, ...probe.input }));
      expect(result.kind).toBe("stopped");
      expect(result.sends).toBe(0);
      expect(stub.calls()).toBe(0);
    }
    const limit = runNegotiationStep(stepInput({ mandate: mandate({ roundsUsed: 3 }) }));
    if (limit.kind === "stopped") expect(limit.reason).toBe("round-limit-reached");
    else throw new Error("expected round-limit stop");
  });

  test("Jev stop move stops with zero sends", () => {
    const stub = stubSender();
    const result = runNegotiationStep(stepInput({ sender: stub.sender, jev: jev({ choice: "stop" }) }));
    expect(result.kind).toBe("stopped");
    if (result.kind === "stopped") expect(result.reason).toBe("stop-move");
    expect(result.sends).toBe(0);
    expect(stub.calls()).toBe(0);
  });

  test("hold move waits for the owner with zero sends", () => {
    const stub = stubSender();
    const result = runNegotiationStep(stepInput({ sender: stub.sender, jev: jev({ choice: "hold" }) }));
    expect(result.kind).toBe("waiting");
    if (result.kind === "waiting") expect(result.reason).toBe("waiting-for-owner");
    expect(result.sends).toBe(0);
    expect(stub.calls()).toBe(0);
  });
});

describe("E6 grant and recipient revocation before send", () => {
  test("revoked or expired grant stops with zero sends", () => {
    for (const [grant, reason] of [
      [current({ grantStatus: "revoked" }), "grant-revoked"],
      [current({ grantStatus: "expired" }), "grant-expired"],
    ] as const) {
      const stub = stubSender();
      const result = runNegotiationStep(stepInput({ sender: stub.sender, current: grant }));
      expect(result.kind).toBe("stopped");
      if (result.kind === "stopped") expect(result.reason).toBe(reason);
      expect(result.sends).toBe(0);
      expect(stub.calls()).toBe(0);
    }
  });

  test("changed or missing grant binding denies with zero sends", () => {
    const changed = runNegotiationStep(stepInput({ current: current({ currentGrantId: "grant-other" }) }));
    expect(changed.kind).toBe("denied");
    if (changed.kind === "denied") expect(changed.code).toBe("grant-binding-changed");
    expect(changed.sends).toBe(0);
    expect(changed.dispatchAttempts).toBe(0);

    const { operationGrantId: _droppedGrant, ...missingRest } = current();
    void _droppedGrant;
    const missing: NegotiationCurrentSnapshot = missingRest;
    const absent = runNegotiationStep(stepInput({ current: missing }));
    expect(absent.kind).toBe("denied");
    if (absent.kind === "denied") expect(absent.code).toBe("grant-binding-changed");
    expect(absent.sends).toBe(0);
  });

  test("grant re-issue and recipient change deny with zero sends", () => {
    const versioned = runNegotiationStep(
      stepInput({ current: current({ grantRevocationVersion: 2 }) }),
    );
    expect(versioned.kind).toBe("denied");
    if (versioned.kind === "denied") expect(versioned.code).toBe("grant-version-changed");
    expect(versioned.sends).toBe(0);

    const recipient = runNegotiationStep(
      stepInput({ current: current({ currentRecipientConfigVersion: 8 }) }),
    );
    expect(recipient.kind).toBe("denied");
    if (recipient.kind === "denied") expect(recipient.code).toBe("recipient-changed");
    expect(recipient.sends).toBe(0);

    const missing = runNegotiationStep(stepInput({ current: current({ recipientConfigured: false }) }));
    expect(missing.kind).toBe("denied");
    if (missing.kind === "denied") expect(missing.code).toBe("recipient-missing");
    expect(missing.sends).toBe(0);
  });

  test("cancelled job and exhausted allowance deny with zero sends", () => {
    const cancelled = runNegotiationStep(stepInput({ current: current({ jobCancelled: true }) }));
    expect(cancelled.kind).toBe("denied");
    if (cancelled.kind === "denied") expect(cancelled.code).toBe("job-cancelled");
    expect(cancelled.sends).toBe(0);

    const exhausted = runNegotiationStep(stepInput({ current: current({ allowanceExhausted: true }) }));
    expect(exhausted.kind).toBe("denied");
    if (exhausted.kind === "denied") expect(exhausted.code).toBe("allowance-exhausted");
    expect(exhausted.sends).toBe(0);
  });

  test("fence helper re-checks authority immediately before transition", () => {
    expect(checkNegotiationFences(mandate(), current())).toBe(null);
    const fence = checkNegotiationFences(mandate(), current({ grantStatus: "revoked" }));
    expect(fence?.kind).toBe("stopped");
  });
});

describe("E6 runtime bounds fail closed", () => {
  test("bounds helper passes usable snapshots and rejects malformed counts", () => {
    expect(checkNegotiationBounds(mandate(), current())).toBe(null);
    for (const bad of [
      mandate({ roundsUsed: NaN }),
      mandate({ roundsUsed: -1 }),
      mandate({ roundsUsed: 1.5 }),
      mandate({ roundLimit: 0 }),
      mandate({ roundLimit: Number.POSITIVE_INFINITY }),
      mandate({ expiresAt: NaN }),
      mandate({ targetMinorUnits: Number.NaN }),
      mandate({ ceilingMinorUnits: Number.POSITIVE_INFINITY }),
    ]) {
      expect(checkNegotiationBounds(bad, current())?.kind).toBe("denied");
    }
    for (const bad of [
      current({ now: NaN }),
      current({ grantExpiresAt: Number.NEGATIVE_INFINITY }),
      current({ conversationVersion: 1.5 }),
      current({ recipientConfigVersion: NaN }),
    ]) {
      expect(checkNegotiationBounds(mandate(), bad)?.kind).toBe("denied");
    }
  });

  test("untyped malformed numerics deny before any dispatch", () => {
    const bypass = {
      ...mandate(),
      roundsUsed: "1",
      targetMinorUnits: "750000",
    } as unknown as MandateSnapshot;
    const stub = stubSender();
    const result = runNegotiationStep(stepInput({ sender: stub.sender, mandate: bypass }));
    expect(result.kind).toBe("denied");
    if (result.kind === "denied") expect(result.code).toBe("invalid-bounds");
    expect(result.sends).toBe(0);
    expect(result.dispatchAttempts).toBe(0);
    expect(stub.calls()).toBe(0);
  });

  test("roundsUsed above the limit never reaches dispatch handling", () => {
    const stub = stubSender();
    const result = runNegotiationStep(stepInput({ sender: stub.sender, mandate: mandate({ roundsUsed: 9 }) }));
    expect(result.kind).toBe("stopped");
    if (result.kind === "stopped") expect(result.reason).toBe("round-limit-reached");
    expect(result.sends).toBe(0);
    expect(stub.calls()).toBe(0);
  });
});

describe("E6 retry idempotency and dispatch outcomes", () => {
  test("identical retry deduplicates without a second send or round", () => {
    const first = runNegotiationStep(stepInput({ requestId: "req-dedup" }));
    expect(first.kind).toBe("sent");
    if (first.kind !== "sent") throw new Error("expected first send");
    let secondCalls = 0;
    const second = runNegotiationStep(
      stepInput({
        requestId: "req-dedup",
        prior: { requestKey: first.requestKey, payloadHash: first.payloadHash },
        sender: {
          executionMode: "controlled",
          send: () => {
            secondCalls += 1;
            return controlledSuccess({ providerMessageId: "msg-should-not-send" });
          },
        },
      }),
    );
    expect(second.kind).toBe("deduplicated");
    expect(second.sends).toBe(0);
    expect(second.dispatchAttempts).toBe(0);
    expect(secondCalls).toBe(0);
    expect(second.roundsUsedAfter).toBe(1);
    if (second.kind === "deduplicated") expect(second.lineage.sendState).toBe("deduplicated");
  });

  test("changed payload on a reused key conflicts with zero sends", () => {
    const stub = stubSender();
    const result = runNegotiationStep(
      stepInput({
        sender: stub.sender,
        requestId: "req-conflict",
        prior: { requestKey: "org-e6|communication.send|req-conflict", payloadHash: "deadbeefdeadbeef" },
      }),
    );
    expect(result.kind).toBe("denied");
    if (result.kind === "denied") expect(result.code).toBe("retry-conflict");
    expect(result.sends).toBe(0);
    expect(stub.calls()).toBe(0);
  });

  test("deduplication gate semantics", () => {
    expect(deduplicateNegotiationRetry("k", "h", null).outcome).toBe("proceed");
    expect(deduplicateNegotiationRetry("k", "h", { requestKey: "k", payloadHash: "h" }).outcome).toBe("deduplicated");
    expect(deduplicateNegotiationRetry("k", "h2", { requestKey: "k", payloadHash: "h" }).outcome).toBe("conflict");
  });

  test("unknown dispatch outcome waits and records one attempt without a send", () => {
    const stub = stubSender(controlledSuccess({ outcome: "unknown", providerMessageId: null, providerThreadId: null, recorded: false }));
    const result = runNegotiationStep(stepInput({ sender: stub.sender }));
    expect(result.kind).toBe("waiting");
    expect(result.sends).toBe(0);
    expect(result.dispatchAttempts).toBe(1);
    expect(stub.calls()).toBe(1);
    expect(result.roundsUsedAfter).toBe(1);
    if (result.kind === "waiting") {
      expect(result.reason).toBe("outcome-unknown");
      expect(result.lineage.sendState).toBe("outcomeUnknown");
      expect(result.lineage.dispatchAttempts).toBe(1);
    }
  });

  test("failed dispatch waits and records one attempt without a send", () => {
    const stub = stubSender(controlledSuccess({ outcome: "failure", recorded: false }));
    const result = runNegotiationStep(stepInput({ sender: stub.sender }));
    expect(result.kind).toBe("waiting");
    expect(result.sends).toBe(0);
    expect(result.dispatchAttempts).toBe(1);
    expect(stub.calls()).toBe(1);
    expect(result.roundsUsedAfter).toBe(1);
    if (result.kind === "waiting") {
      expect(result.reason).toBe("send-failure");
      expect(result.lineage.sendState).toBe("observedFailure");
    }
  });

  test("unrecorded success denies and never increments the round", () => {
    const stub = stubSender(controlledSuccess({ recorded: false }));
    const result = runNegotiationStep(stepInput({ sender: stub.sender }));
    expect(result.kind).toBe("denied");
    expect(result.sends).toBe(0);
    expect(result.dispatchAttempts).toBe(1);
    expect(stub.calls()).toBe(1);
    expect(result.roundsUsedAfter).toBe(1);
    if (result.kind === "denied") {
      expect(result.code).toBe("provider-result-malformed");
      expect(result.lineage.dispatchAttempts).toBe(1);
    }
  });

  test("success without a provider message id denies and never increments", () => {
    const stub = stubSender(controlledSuccess({ providerMessageId: null }));
    const result = runNegotiationStep(stepInput({ sender: stub.sender }));
    expect(result.kind).toBe("denied");
    if (result.kind === "denied") expect(result.code).toBe("provider-result-malformed");
    expect(result.roundsUsedAfter).toBe(1);
  });

  test("adapter denial denies after recording the attempt", () => {
    const stub = stubSender({ ok: false, code: "transport-down", message: "controlled adapter refusal" });
    const result = runNegotiationStep(stepInput({ sender: stub.sender }));
    expect(result.kind).toBe("denied");
    expect(result.sends).toBe(0);
    expect(result.dispatchAttempts).toBe(1);
    expect(stub.calls()).toBe(1);
    if (result.kind === "denied") expect(result.code).toBe("dispatch-denied");
  });

  test("round accounting advances only recorded success with a message id", () => {
    const recorded = controlledSuccess();
    expect(applyControlledDispatchOutcome(2, recorded)).toMatchObject({
      outcome: "sent",
      sendState: "observedSuccess",
      roundsUsedAfter: 3,
    });
    if (recorded.ok) {
      expect(applyControlledDispatchOutcome(2, { ...recorded, recorded: false }).outcome).toBe("denied");
      expect(applyControlledDispatchOutcome(2, { ...recorded, providerMessageId: null }).outcome).toBe("denied");
      expect(applyControlledDispatchOutcome(2, { ...recorded, outcome: "unknown" }).outcome).toBe("waiting");
      expect(applyControlledDispatchOutcome(2, { ...recorded, outcome: "failure" }).outcome).toBe("waiting");
    } else {
      throw new Error("expected controlled success fixture");
    }
    expect(applyControlledDispatchOutcome(2, { ok: false, code: "x", message: "y" }).outcome).toBe("denied");
  });

  test("malformed adapter results deny with the attempt recorded", () => {
    expect(validateControlledDispatchResult(null).ok).toBe(false);
    expect(validateControlledDispatchResult({ ok: true, outcome: "delivered" }).ok).toBe(false);
    expect(
      validateControlledDispatchResult({ ok: true, outcome: "success", providerMessageId: "  ", providerThreadId: null, recorded: true }).ok,
    ).toBe(false);
    expect(
      validateControlledDispatchResult({ ok: true, outcome: "success", providerMessageId: "m", providerThreadId: null }).ok,
    ).toBe(false);
    const valid = validateControlledDispatchResult(controlledSuccess());
    expect(valid.ok).toBe(true);
  });

  test("non-controlled sender is refused before any invocation", () => {
    let calls = 0;
    const liveLike = {
      executionMode: "live",
      send: () => {
        calls += 1;
        return controlledSuccess({ providerMessageId: "msg-live" });
      },
    };
    const result = runNegotiationStep(
      stepInput({ sender: liveLike as unknown as ControlledNegotiationSender }),
    );
    expect(result.kind).toBe("denied");
    if (result.kind === "denied") expect(result.code).toBe("live-transport-refused");
    expect(calls).toBe(0);
    expect(result.sends).toBe(0);
    expect(result.dispatchAttempts).toBe(0);
  });
});

describe("E6 versioned J-06 corpus extension", () => {
  test("corpus version is pinned and every J-06 category is extended", () => {
    expect(E6_NEGOTIATION_CORPUS_VERSION).toBe("e6-negotiation-corpus-v1");
    const categories = new Set(E6_NEGOTIATION_CORPUS.map((item) => item.j06Category));
    for (const required of ["incomplete-offer", "short-followup", "unrelated", "adversarial", "changed-reply"] as const) {
      expect(categories.has(required)).toBe(true);
    }
    for (const item of E6_NEGOTIATION_CORPUS) {
      expect(item.id).toMatch(/^e6-neg-/);
      expect(item.permittedMoves.length).toBeGreaterThan(0);
    }
  });

  test("in-policy selections score cleanly and out-of-policy selections are reported", () => {
    const clean = scoreE6NegotiationCorpus((choice) => {
      const found = E6_NEGOTIATION_CORPUS.find((item) => item.jevChoice === choice);
      const first = found?.permittedMoves[0];
      return first ?? null;
    });
    expect(clean.evaluated).toBe(E6_NEGOTIATION_CORPUS.length);
    expect(clean.inPolicy).toBe(clean.evaluated);
    expect(clean.outOfPolicy).toEqual([]);

    const rigged = scoreE6NegotiationCorpus(() => "counter");
    expect(rigged.outOfPolicy.length).toBeGreaterThan(0);
    expect(rigged.outOfPolicy).toContain("e6-neg-04");
  });
});

describe("E6 loop metadata and zero-live-transport proof", () => {
  test("loop version is pinned and the operation kind reuses the C1 send path", () => {
    expect(NEGOTIATION_LOOP_VERSION).toBe("e6-negotiation-loop-v1");
    expect(NEGOTIATION_OPERATION_KIND).toBe("communication.send");
    expect(NEGOTIATION_OPENAI_MODEL).toBe("gpt-5.4-mini-2026-03-17");
    expect(JEV_PINNED_MODEL).toBe("jev-1.13.0");
  });

  test("no live fetch exists: every denial and wait in this suite performed zero sends", () => {
    const denials: NegotiationStepInput[] = [
      stepInput({ jev: jev({ choice: "accept" }) }),
      stepInput({ current: current({ grantStatus: "revoked" }) }),
      stepInput({ current: current({ quoteSuperseded: true }) }),
      stepInput({ mandate: mandate({ roundsUsed: 3 }) }),
      stepInput({ draft: draft({ content: `write to ${OWNER_MAILBOX}` }) }),
    ];
    for (const probe of denials) {
      const result = runNegotiationStep(probe);
      expect(result.kind).not.toBe("sent");
      expect(result.sends).toBe(0);
      expect(result.lineage.executionMode).toBe("controlled");
      expect(result.lineage.loopVersion).toBe("e6-negotiation-loop-v1");
      expect(result.lineage.evidenceLabel).toContain("controlled");
    }
  });
});
