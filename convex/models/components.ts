import { componentsGeneric } from "convex/server";

/**
 * The official generic component reference is safe before a hosted deployment
 * has produced named generated refs. Convex codegen can replace this import
 * with its named `components` export once a deployment is available.
 */
export const components = componentsGeneric();
