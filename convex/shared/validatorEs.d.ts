/**
 * Local typings for the validator ES subpath used by mailbox.ts.
 * The published @types/validator package declares only the package root
 * and its CommonJS `lib/` mirror, so this narrow ambient declaration
 * covers the audited runtime-safe `es/` entry without widening to the
 * UMD bundle.
 */
declare module "validator/es/lib/isEmail.js" {
  import type { IsEmailOptions } from "validator";
  const isEmail: (value: string, options?: IsEmailOptions) => boolean;
  export default isEmail;
}
