/**
 * F1 locations (controlled contract, PRD section 30).
 *
 * Locations belong to an organization and carry region, reporting
 * defaults, and operating status. Projects attach via the optional
 * `locationId` reference; the reference is validated to the same
 * organization before it is stored.
 */

import { v } from "convex/values";
import { f1Mutation, f1Query } from "../server.js";
import { denialValidator } from "../access/checks.js";
import {
  requireDomainAccess,
  requireOrganizationAccess,
} from "./guards.js";

const locationResultValidator = v.union(
  v.object({ ok: v.literal(true), locationId: v.id("locations") }),
  denialValidator,
);

/** Create an organization-level location (contributor and above). */
export const create = f1Mutation({
  args: {
    organizationId: v.id("organizations"),
    name: v.string(),
    region: v.string(),
    reportingCurrency: v.string(),
    operatingStatus: v.string(),
  },
  returns: locationResultValidator,
  handler: async (ctx, args) => {
    const access = await requireOrganizationAccess(
      ctx,
      args.organizationId,
      "contributor",
    );
    if (!access.ok) {
      return { ok: false as const, code: access.code, message: access.message };
    }
    if (args.name.trim().length === 0) {
      return { ok: false as const, code: "invalid-payload", message: "name required" };
    }
    const locationId = await ctx.db.insert("locations", {
      organizationId: args.organizationId,
      name: args.name,
      region: args.region,
      reportingCurrency: args.reportingCurrency,
      operatingStatus: args.operatingStatus,
      createdAt: Date.now(),
    });
    return { ok: true as const, locationId };
  },
});

/** Read one location; the row must belong to the caller's organization. */
export const get = f1Query({
  args: {
    organizationId: v.id("organizations"),
    locationId: v.id("locations"),
  },
  returns: v.union(
    v.object({
      ok: v.literal(true),
      name: v.string(),
      region: v.string(),
      reportingCurrency: v.string(),
      operatingStatus: v.string(),
    }),
    denialValidator,
  ),
  handler: async (ctx, args) => {
    const access = await requireOrganizationAccess(
      ctx,
      args.organizationId,
      "viewer",
    );
    if (!access.ok) {
      return { ok: false as const, code: access.code, message: access.message };
    }
    const row = await ctx.db.get(args.locationId);
    if (row === null || row.organizationId !== args.organizationId) {
      return { ok: false as const, code: "denied-membership", message: "not authorized" };
    }
    return {
      ok: true as const,
      name: row.name,
      region: row.region,
      reportingCurrency: row.reportingCurrency,
      operatingStatus: row.operatingStatus,
    };
  },
});

/**
 * Attach a project to a location. Both rows must share the organization;
 * a foreign location is rejected before any write.
 */
export const attachProject = f1Mutation({
  args: {
    organizationId: v.id("organizations"),
    projectId: v.id("projects"),
    locationId: v.id("locations"),
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
    const location = await ctx.db.get(args.locationId);
    if (location === null || location.organizationId !== args.organizationId) {
      return { ok: false as const, code: "denied-project", message: "location is not in this organization" };
    }
    await ctx.db.patch(args.projectId, { locationId: args.locationId });
    return { ok: true as const };
  },
});
