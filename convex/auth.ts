import GitHub from "@auth/core/providers/github";
import { Anonymous } from "@convex-dev/auth/providers/Anonymous";
import { convexAuth } from "@convex-dev/auth/server";

/**
 * F0 registers the official anonymous evaluator identity and a GitHub OAuth
 * provider using deployment-only credentials. Project isolation and capability
 * checks remain F1 backend responsibilities; no provider call happens here.
 */
export function hasGitHubOAuthCredentials(clientId: string | undefined, clientSecret: string | undefined): boolean {
  return typeof clientId === "string"
    && clientId.trim().length > 0
    && typeof clientSecret === "string"
    && clientSecret.trim().length > 0;
}

function createGitHubProvider(clientId: string | undefined, clientSecret: string | undefined) {
  if (typeof clientId !== "string" || clientId.trim().length === 0) return null;
  if (typeof clientSecret !== "string" || clientSecret.trim().length === 0) return null;
  return GitHub({ clientId, clientSecret });
}

const github = createGitHubProvider(process.env.AUTH_GITHUB_ID, process.env.AUTH_GITHUB_SECRET);

export const { auth, signIn, signOut, store, isAuthenticated } = convexAuth({
  providers: github === null ? [Anonymous] : [Anonymous, github],
});
