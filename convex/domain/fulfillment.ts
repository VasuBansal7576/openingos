/**
 * F1 fulfillment graph (controlled contract, PRD 17, ADR-0003).
 *
 * Orders record externally placed commitments against a selection;
 * selection changes forecast, only recorded orders change commitments.
 * Order events track confirmation through commissioning with accepted
 * quantities kept separate from ordered quantities. Cost entries record
 * payments, settled costs, refunds, and credits with idempotency keys;
 * a price-reducing credit changes the obligation once and a cash refund
 * changes applied payments once (linked, never double-subtracted).
 * Commissioning creates installed-asset provenance; service cases track
 * equipment issues against those assets.
 */

import { v } from "convex/values";
import { f1Mutation, f1Query } from "../server.js";
import { denialValidator } from "../access/checks.js";
import {
  decimalAdd,
  decimalCompare,
  decimalToString,
  decimalZero,
  parseDecimalString,
  quantity,
  type Decimal,
} from "../../proofs/money/decimal.js";
import {
  assetDocumentInputValidator,
  assetInputValidator,
  costEntryInputValidator,
  orderEventInputValidator,
  orderInputValidator,
  serviceCaseInputValidator,
} from "../shared/domainContracts.js";
import { checkMoney } from "../shared/money.js";
import { requireDomainAccess, requireOwnedRef } from "./guards.js";

const orderResultValidator = v.union(
  v.object({ ok: v.literal(true), orderId: v.id("orders"), deduplicated: v.boolean() }),
  denialValidator,
);

/**
 * Record an externally placed order. The order pins the selection's full
 * lineage (requirement, quote, exact quote version, requirement version)
 * so fulfillment never floats free of the decision it executes. The
 * idempotency key is unique per project: a replay with identical fields
 * returns the existing row, while a replay with different fields is a
 * `duplicate-conflict` so a collision can never silently swap the
 * selection or quantity.
 */
export const recordOrder = f1Mutation({
  args: orderInputValidator.fields,
  returns: orderResultValidator,
  handler: async (ctx, args) => {
    const access = await requireDomainAccess(
      ctx,
      args.organizationId,
      args.projectId,
      "contributor",
    );
    if (!access.ok) {
      return { ok: false as const, code: access.code, message: access.message };
    }
    if (args.idempotencyKey.trim().length === 0) {
      return { ok: false as const, code: "invalid-payload", message: "idempotency key required" };
    }
    // Quantities compare in normalized decimal form so `1` and `1.0`
    // replay as the same commitment instead of conflicting.
    let ordered: Decimal;
    try {
      ordered = quantity(args.orderedQuantity);
    } catch {
      return { ok: false as const, code: "invalid-payload", message: "ordered quantity is not a valid decimal" };
    }
    if (decimalCompare(ordered, decimalZero()) <= 0) {
      return { ok: false as const, code: "invalid-payload", message: "ordered quantity must be positive" };
    }
    const normalizedOrdered = decimalToString(ordered);
    const existing = await ctx.db
      .query("orders")
      .withIndex("by_project_and_key", (q) =>
        q.eq("projectId", args.projectId).eq("idempotencyKey", args.idempotencyKey),
      )
      .unique();
    if (existing !== null) {
      if (existing.organizationId !== args.organizationId) {
        return { ok: false as const, code: "denied-project", message: "reference is not in this project" };
      }
      const sameSupplier =
        (existing.supplierReference ?? undefined) === args.supplierReference;
      if (
        existing.selectionId !== args.selectionId ||
        existing.orderedQuantity !== normalizedOrdered ||
        !sameSupplier
      ) {
        return { ok: false as const, code: "duplicate-conflict", message: "idempotency key already used with different fields" };
      }
      return { ok: true as const, orderId: existing._id, deduplicated: true };
    }
    const selection = await requireOwnedRef(
      await ctx.db.get(args.selectionId),
      args.organizationId,
      args.projectId,
    );
    if (!selection.ok) {
      return { ok: false as const, code: selection.code, message: selection.message };
    }
    const now = Date.now();
    const orderId = await ctx.db.insert("orders", {
      organizationId: args.organizationId,
      projectId: args.projectId,
      selectionId: args.selectionId,
      requirementId: selection.value.requirementId,
      quoteId: selection.value.quoteId,
      quoteVersion: selection.value.quoteVersion,
      requirementVersion: selection.value.requirementVersion,
      idempotencyKey: args.idempotencyKey,
      orderedQuantity: normalizedOrdered,
      ...(args.supplierReference === undefined ? {} : { supplierReference: args.supplierReference }),
      state: "recorded",
      amendmentCount: 0,
      createdAt: now,
      updatedAt: now,
    });
    return { ok: true as const, orderId, deduplicated: false };
  },
});

/** List orders for a project (bounded through the project index). */
export const listOrders = f1Query({
  args: {
    organizationId: v.id("organizations"),
    projectId: v.id("projects"),
    limit: v.number(),
  },
  returns: v.union(
    v.object({
      ok: v.literal(true),
      orders: v.array(
        v.object({ id: v.id("orders"), state: v.string(), orderedQuantity: v.string() }),
      ),
    }),
    denialValidator,
  ),
  handler: async (ctx, args) => {
    const access = await requireDomainAccess(
      ctx,
      args.organizationId,
      args.projectId,
      "viewer",
    );
    if (!access.ok) {
      return { ok: false as const, code: access.code, message: access.message };
    }
    const rows = await ctx.db
      .query("orders")
      .withIndex("by_project", (q) => q.eq("projectId", args.projectId))
      .take(Math.max(1, Math.min(50, Math.floor(args.limit))));
    return {
      ok: true as const,
      orders: rows
        .filter((row) => row.organizationId === args.organizationId)
        .map((row) => ({ id: row._id, state: row.state, orderedQuantity: row.orderedQuantity })),
    };
  },
});

/**
 * Append an order event (confirmation through commissioning). The order
 * must live in the caller's project; accepted quantities are recorded
 * separately from ordered quantities and can never exceed them:
 * accepted units accumulate across the order's exact event history, so
 * partial deliveries account for accepted units without over-accepting.
 */
export const appendOrderEvent = f1Mutation({
  args: orderEventInputValidator.fields,
  returns: v.union(
    v.object({ ok: v.literal(true), eventId: v.id("orderEvents"), deduplicated: v.boolean() }),
    denialValidator,
  ),
  handler: async (ctx, args) => {
    const access = await requireDomainAccess(
      ctx,
      args.organizationId,
      args.projectId,
      "contributor",
    );
    if (!access.ok) {
      return { ok: false as const, code: access.code, message: access.message };
    }
    if (args.idempotencyKey.trim().length === 0) {
      return { ok: false as const, code: "invalid-payload", message: "idempotency key required" };
    }
    // Accepted quantities compare normalized so `1` and `1.0` replay
    // as the same event instead of conflicting.
    let normalizedAccepted: string | undefined;
    if (args.acceptedQuantity !== undefined) {
      try {
        normalizedAccepted = decimalToString(
          parseDecimalString(args.acceptedQuantity, "accepted quantity"),
        );
      } catch {
        return { ok: false as const, code: "invalid-payload", message: "accepted quantity is not a valid decimal" };
      }
    }
    const existing = await ctx.db
      .query("orderEvents")
      .withIndex("by_project_and_key", (q) =>
        q.eq("projectId", args.projectId).eq("idempotencyKey", args.idempotencyKey),
      )
      .unique();
    if (existing !== null) {
      if (existing.organizationId !== args.organizationId) {
        return { ok: false as const, code: "denied-project", message: "reference is not in this project" };
      }
      const sameAccepted =
        (existing.acceptedQuantity ?? undefined) === normalizedAccepted;
      const sameNote = (existing.note ?? undefined) === args.note;
      if (
        existing.orderId !== args.orderId ||
        existing.kind !== args.kind ||
        !sameAccepted ||
        !sameNote
      ) {
        return { ok: false as const, code: "duplicate-conflict", message: "idempotency key already used with different fields" };
      }
      return { ok: true as const, eventId: existing._id, deduplicated: true };
    }
    const order = await requireOwnedRef(
      await ctx.db.get(args.orderId),
      args.organizationId,
      args.projectId,
    );
    if (!order.ok) {
      return { ok: false as const, code: order.code, message: order.message };
    }
    let accepted: Decimal | null = null;
    if (normalizedAccepted !== undefined) {
      try {
        accepted = parseDecimalString(normalizedAccepted, "accepted quantity");
      } catch {
        return { ok: false as const, code: "invalid-payload", message: "accepted quantity is not a valid decimal" };
      }
      let cumulative = accepted;
      for await (const prior of ctx.db
        .query("orderEvents")
        .withIndex("by_order", (q) => q.eq("orderId", args.orderId))) {
        if (
          prior.organizationId !== args.organizationId ||
          prior.projectId !== args.projectId ||
          prior.acceptedQuantity === undefined
        ) {
          continue;
        }
        try {
          cumulative = decimalAdd(cumulative, parseDecimalString(prior.acceptedQuantity, "accepted quantity"));
        } catch {
          return { ok: false as const, code: "invalid-payload", message: "stored accepted quantity is invalid" };
        }
      }
      let ordered: Decimal;
      try {
        ordered = quantity(order.value.orderedQuantity);
      } catch {
        return { ok: false as const, code: "invalid-payload", message: "stored ordered quantity is invalid" };
      }
      if (decimalCompare(cumulative, ordered) > 0) {
        return { ok: false as const, code: "invalid-payload", message: "accepted quantity exceeds ordered quantity" };
      }
    }
    const eventId = await ctx.db.insert("orderEvents", {
      organizationId: args.organizationId,
      projectId: args.projectId,
      orderId: args.orderId,
      kind: args.kind,
      ...(accepted === null ? {} : { acceptedQuantity: decimalToString(accepted) }),
      ...(args.note === undefined ? {} : { note: args.note }),
      recordedBy: access.value.identity,
      idempotencyKey: args.idempotencyKey,
      createdAt: Date.now(),
    });
    return { ok: true as const, eventId, deduplicated: false };
  },
});

const costEntryResultValidator = v.union(
  v.object({ ok: v.literal(true), entryId: v.id("costEntries"), deduplicated: v.boolean() }),
  denialValidator,
);

/**
 * Record a payment, settled cost, refund, or credit. The idempotency key
 * is unique per project: a replay with identical fields returns the
 * existing row, while a replay with different order, kind, amount, or
 * link is a `duplicate-conflict` so a collision can never silently swap
 * cash. Linked credit/refund pairs reference each other without
 * subtracting either twice (that rule lives in the budget engine, which
 * reads each entry exactly once).
 */
export const recordCostEntry = f1Mutation({
  args: costEntryInputValidator.fields,
  returns: costEntryResultValidator,
  handler: async (ctx, args) => {
    const access = await requireDomainAccess(
      ctx,
      args.organizationId,
      args.projectId,
      "contributor",
    );
    if (!access.ok) {
      return { ok: false as const, code: access.code, message: access.message };
    }
    if (args.idempotencyKey.trim().length === 0) {
      return { ok: false as const, code: "invalid-payload", message: "idempotency key required" };
    }
    // F1R-09: cost-entry money validates through the accepted
    // proofs/money contract before any write. Nonfinite, fractional,
    // or unsafe minor units and invalid currency are denied; zero and
    // negative amounts are forbidden for every entry kind.
    let checkedAmount: { currency: string; minorUnits: number };
    try {
      checkedAmount = checkMoney(args.amount, "entry amount");
    } catch {
      return { ok: false as const, code: "invalid-payload", message: "entry amount is invalid" };
    }
    if (checkedAmount.minorUnits <= 0) {
      return { ok: false as const, code: "invalid-payload", message: "entry amount must be positive" };
    }
    const existing = await ctx.db
      .query("costEntries")
      .withIndex("by_project_and_key", (q) =>
        q.eq("projectId", args.projectId).eq("idempotencyKey", args.idempotencyKey),
      )
      .unique();
    if (existing !== null) {
      if (existing.organizationId !== args.organizationId) {
        return { ok: false as const, code: "denied-project", message: "reference is not in this project" };
      }
      const sameLink =
        (existing.linkedEntryId ?? undefined) === args.linkedEntryId;
      if (
        existing.orderId !== args.orderId ||
        existing.kind !== args.kind ||
        existing.amount.currency !== checkedAmount.currency ||
        existing.amount.minorUnits !== checkedAmount.minorUnits ||
        !sameLink
      ) {
        return { ok: false as const, code: "duplicate-conflict", message: "idempotency key already used with different fields" };
      }
      return { ok: true as const, entryId: existing._id, deduplicated: true };
    }
    const order = await requireOwnedRef(
      await ctx.db.get(args.orderId),
      args.organizationId,
      args.projectId,
    );
    if (!order.ok) {
      return { ok: false as const, code: order.code, message: order.message };
    }
    // Currency lineage: the entry currency must match the quote currency
    // pinned on the order, so mixed-currency cash can never slip in
    // without an accepted conversion basis.
    const selection = await requireOwnedRef(
      await ctx.db.get(order.value.selectionId),
      args.organizationId,
      args.projectId,
    );
    if (!selection.ok) {
      return { ok: false as const, code: selection.code, message: selection.message };
    }
    const quote = await ctx.db.get(selection.value.quoteId);
    if (
      quote === null ||
      quote.organizationId !== args.organizationId ||
      quote.projectId !== args.projectId
    ) {
      return { ok: false as const, code: "denied-project", message: "quote is not in this project" };
    }
    if (checkedAmount.currency !== quote.currency) {
      return { ok: false as const, code: "invalid-payload", message: "mixed-currency-requires-accepted-conversion-basis" };
    }
    if (args.linkedEntryId !== undefined) {
      const linked = await ctx.db.get(args.linkedEntryId);
      if (
        linked === null ||
        linked.organizationId !== args.organizationId ||
        linked.projectId !== args.projectId ||
        linked.orderId !== args.orderId
      ) {
        return { ok: false as const, code: "denied-project", message: "linked entry is not on this order" };
      }
    }
    const entryId = await ctx.db.insert("costEntries", {
      organizationId: args.organizationId,
      projectId: args.projectId,
      orderId: args.orderId,
      kind: args.kind,
      amount: { currency: checkedAmount.currency, minorUnits: checkedAmount.minorUnits },
      idempotencyKey: args.idempotencyKey,
      ...(args.linkedEntryId === undefined ? {} : { linkedEntryId: args.linkedEntryId }),
      recordedBy: access.value.identity,
      createdAt: Date.now(),
    });
    return { ok: true as const, entryId, deduplicated: false };
  },
});

/**
 * Record installed equipment. Location and order provenance must resolve
 * inside the project when supplied; the order's full decision lineage
 * (selection, requirement, quote) is re-verified so an asset can never
 * dangle off a foreign commitment. Purchase provenance stays a label,
 * never a rewritten history. The idempotency key replays exactly or
 * conflicts.
 */
export const recordAsset = f1Mutation({
  args: assetInputValidator.fields,
  returns: v.union(
    v.object({ ok: v.literal(true), assetId: v.id("assets"), deduplicated: v.boolean() }),
    denialValidator,
  ),
  handler: async (ctx, args) => {
    const access = await requireDomainAccess(
      ctx,
      args.organizationId,
      args.projectId,
      "contributor",
    );
    if (!access.ok) {
      return { ok: false as const, code: access.code, message: access.message };
    }
    if (args.idempotencyKey.trim().length === 0) {
      return { ok: false as const, code: "invalid-payload", message: "idempotency key required" };
    }
    if (args.label.trim().length === 0) {
      return { ok: false as const, code: "invalid-payload", message: "label required" };
    }
    const existing = await ctx.db
      .query("assets")
      .withIndex("by_project_and_key", (q) =>
        q.eq("projectId", args.projectId).eq("idempotencyKey", args.idempotencyKey),
      )
      .unique();
    if (existing !== null) {
      if (existing.organizationId !== args.organizationId) {
        return { ok: false as const, code: "denied-project", message: "reference is not in this project" };
      }
      const sameLocation = (existing.locationId ?? undefined) === args.locationId;
      const sameOrder = (existing.orderId ?? undefined) === args.orderId;
      const sameSerial = (existing.serial ?? undefined) === args.serial;
      const sameConstraints = (existing.constraints ?? undefined) === args.constraints;
      const sameProvenance =
        (existing.purchaseProvenance ?? undefined) === args.purchaseProvenance;
      if (
        existing.label !== args.label ||
        !sameLocation ||
        !sameOrder ||
        !sameSerial ||
        !sameConstraints ||
        !sameProvenance
      ) {
        return { ok: false as const, code: "duplicate-conflict", message: "idempotency key already used with different fields" };
      }
      return { ok: true as const, assetId: existing._id, deduplicated: true };
    }
    if (args.locationId !== undefined) {
      const location = await ctx.db.get(args.locationId);
      if (location === null || location.organizationId !== args.organizationId) {
        return { ok: false as const, code: "denied-project", message: "location is not in this organization" };
      }
    }
    if (args.orderId !== undefined) {
      const order = await requireOwnedRef(
        await ctx.db.get(args.orderId),
        args.organizationId,
        args.projectId,
      );
      if (!order.ok) {
        return { ok: false as const, code: order.code, message: order.message };
      }
      const selection = await requireOwnedRef(
        await ctx.db.get(order.value.selectionId),
        args.organizationId,
        args.projectId,
      );
      if (!selection.ok) {
        return { ok: false as const, code: selection.code, message: selection.message };
      }
    }
    const assetId = await ctx.db.insert("assets", {
      organizationId: args.organizationId,
      projectId: args.projectId,
      ...(args.locationId === undefined ? {} : { locationId: args.locationId }),
      ...(args.orderId === undefined ? {} : { orderId: args.orderId }),
      label: args.label,
      ...(args.serial === undefined ? {} : { serial: args.serial }),
      ...(args.constraints === undefined ? {} : { constraints: args.constraints }),
      ...(args.purchaseProvenance === undefined ? {} : { purchaseProvenance: args.purchaseProvenance }),
      idempotencyKey: args.idempotencyKey,
      createdAt: Date.now(),
    });
    return { ok: true as const, assetId, deduplicated: false };
  },
});

/** Attach an authorized document link to an in-project asset. */
export const recordAssetDocument = f1Mutation({
  args: assetDocumentInputValidator.fields,
  returns: v.union(
    v.object({ ok: v.literal(true), documentId: v.id("assetDocuments"), deduplicated: v.boolean() }),
    denialValidator,
  ),
  handler: async (ctx, args) => {
    const access = await requireDomainAccess(
      ctx,
      args.organizationId,
      args.projectId,
      "contributor",
    );
    if (!access.ok) {
      return { ok: false as const, code: access.code, message: access.message };
    }
    if (args.idempotencyKey.trim().length === 0) {
      return { ok: false as const, code: "invalid-payload", message: "idempotency key required" };
    }
    if (args.kind.trim().length === 0) {
      return { ok: false as const, code: "invalid-payload", message: "document kind required" };
    }
    const existing = await ctx.db
      .query("assetDocuments")
      .withIndex("by_project_and_key", (q) =>
        q.eq("projectId", args.projectId).eq("idempotencyKey", args.idempotencyKey),
      )
      .unique();
    if (existing !== null) {
      if (existing.organizationId !== args.organizationId) {
        return { ok: false as const, code: "denied-project", message: "reference is not in this project" };
      }
      const sameStorage = (existing.storageRef ?? undefined) === args.storageRef;
      if (existing.assetId !== args.assetId || existing.kind !== args.kind || !sameStorage) {
        return { ok: false as const, code: "duplicate-conflict", message: "idempotency key already used with different fields" };
      }
      return { ok: true as const, documentId: existing._id, deduplicated: true };
    }
    const asset = await requireOwnedRef(
      await ctx.db.get(args.assetId),
      args.organizationId,
      args.projectId,
    );
    if (!asset.ok) {
      return { ok: false as const, code: asset.code, message: asset.message };
    }
    const documentId = await ctx.db.insert("assetDocuments", {
      organizationId: args.organizationId,
      projectId: args.projectId,
      assetId: args.assetId,
      kind: args.kind,
      ...(args.storageRef === undefined ? {} : { storageRef: args.storageRef }),
      idempotencyKey: args.idempotencyKey,
      createdAt: Date.now(),
    });
    return { ok: true as const, documentId, deduplicated: false };
  },
});

/** Open a service case against an in-project asset. */
export const openServiceCase = f1Mutation({
  args: serviceCaseInputValidator.fields,
  returns: v.union(
    v.object({ ok: v.literal(true), caseId: v.id("serviceCases"), deduplicated: v.boolean() }),
    denialValidator,
  ),
  handler: async (ctx, args) => {
    const access = await requireDomainAccess(
      ctx,
      args.organizationId,
      args.projectId,
      "contributor",
    );
    if (!access.ok) {
      return { ok: false as const, code: access.code, message: access.message };
    }
    if (args.idempotencyKey.trim().length === 0) {
      return { ok: false as const, code: "invalid-payload", message: "idempotency key required" };
    }
    if (args.summary.trim().length === 0) {
      return { ok: false as const, code: "invalid-payload", message: "summary required" };
    }
    const existing = await ctx.db
      .query("serviceCases")
      .withIndex("by_project_and_key", (q) =>
        q.eq("projectId", args.projectId).eq("idempotencyKey", args.idempotencyKey),
      )
      .unique();
    if (existing !== null) {
      if (existing.organizationId !== args.organizationId) {
        return { ok: false as const, code: "denied-project", message: "reference is not in this project" };
      }
      if (
        existing.assetId !== args.assetId ||
        existing.urgency !== args.urgency ||
        existing.summary !== args.summary
      ) {
        return { ok: false as const, code: "duplicate-conflict", message: "idempotency key already used with different fields" };
      }
      return { ok: true as const, caseId: existing._id, deduplicated: true };
    }
    const asset = await requireOwnedRef(
      await ctx.db.get(args.assetId),
      args.organizationId,
      args.projectId,
    );
    if (!asset.ok) {
      return { ok: false as const, code: asset.code, message: asset.message };
    }
    const now = Date.now();
    const caseId = await ctx.db.insert("serviceCases", {
      organizationId: args.organizationId,
      projectId: args.projectId,
      assetId: args.assetId,
      urgency: args.urgency,
      summary: args.summary,
      state: "open",
      idempotencyKey: args.idempotencyKey,
      createdAt: now,
      updatedAt: now,
    });
    return { ok: true as const, caseId, deduplicated: false };
  },
});

/** Advance a service case; terminal cases never reopen. */
export const updateServiceCase = f1Mutation({
  args: {
    organizationId: v.id("organizations"),
    projectId: v.id("projects"),
    caseId: v.id("serviceCases"),
    state: v.union(
      v.literal("open"),
      v.literal("inProgress"),
      v.literal("waitingForSupplier"),
      v.literal("resolved"),
      v.literal("closed"),
    ),
    outcome: v.optional(v.string()),
  },
  returns: v.union(v.object({ ok: v.literal(true) }), denialValidator),
  handler: async (ctx, args) => {
    const access = await requireDomainAccess(
      ctx,
      args.organizationId,
      args.projectId,
      "contributor",
    );
    if (!access.ok) {
      return { ok: false as const, code: access.code, message: access.message };
    }
    const serviceCase = await requireOwnedRef(
      await ctx.db.get(args.caseId),
      args.organizationId,
      args.projectId,
    );
    if (!serviceCase.ok) {
      return { ok: false as const, code: serviceCase.code, message: serviceCase.message };
    }
    if (serviceCase.value.state === "closed" && args.state !== "closed") {
      return { ok: false as const, code: "invalid-payload", message: "closed cases never reopen" };
    }
    await ctx.db.patch(args.caseId, {
      state: args.state,
      ...(args.outcome === undefined ? {} : { outcome: args.outcome }),
      updatedAt: Date.now(),
    });
    return { ok: true as const };
  },
});
