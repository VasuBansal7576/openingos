/**
 * F1 owned Convex typing helper (controlled contract, NR03 gate).
 *
 * Official Convex codegen remains blocked on deployment (F0-owned), so the
 * generated `_generated/dataModel` is still permissive. This hand-written
 * helper derives the exact `F1DataModel` from `typeof schema` with the
 * version-current `DataModelFromSchemaDefinition` API and binds the generic
 * function builders to it — no generated file is edited, and every F1
 * handler below gets typed `ctx.db`, schema-declared indexes, and `Id`
 * table branding. Once official codegen runs, this file becomes redundant
 * and handlers migrate to the generated bindings.
 */

import {
  actionGeneric,
  internalMutationGeneric,
  internalQueryGeneric,
  mutationGeneric,
  queryGeneric,
  type ActionBuilder,
  type DataModelFromSchemaDefinition,
  type GenericActionCtx,
  type GenericMutationCtx,
  type GenericQueryCtx,
  type MutationBuilder,
  type QueryBuilder,
} from "convex/server";
import schema from "./schema.js";

export type F1DataModel = DataModelFromSchemaDefinition<typeof schema>;

export const f1Query: QueryBuilder<F1DataModel, "public"> = queryGeneric;
export const f1Mutation: MutationBuilder<F1DataModel, "public"> = mutationGeneric;
export const f1InternalQuery: QueryBuilder<F1DataModel, "internal"> = internalQueryGeneric;
export const f1InternalMutation: MutationBuilder<F1DataModel, "internal"> = internalMutationGeneric;
export const f1Action: ActionBuilder<F1DataModel, "public"> = actionGeneric;

export type F1QueryCtx = GenericQueryCtx<F1DataModel>;
export type F1MutationCtx = GenericMutationCtx<F1DataModel>;
export type F1ActionCtx = GenericActionCtx<F1DataModel>;
