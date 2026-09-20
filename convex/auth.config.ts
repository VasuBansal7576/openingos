import type { AuthConfig } from "convex/server";

/**
 * Convex Auth validates tokens against the deployment's published site origin.
 * The origin is intentionally read from deployment configuration, never guessed
 * locally; hosted redirect and refresh behavior remains unverified in F0.
 */
export default {
  providers: [
    {
      domain: process.env.CONVEX_SITE_URL!,
      applicationID: "convex",
    },
  ],
} satisfies AuthConfig;
