import GitHub from "@auth/core/providers/github";
import { Anonymous } from "@convex-dev/auth/providers/Anonymous";
import { convexAuth } from "@convex-dev/auth/server";

/**
 * F0 registers the official anonymous evaluator identity and a GitHub OAuth
 * provider using deployment-only credentials. Project isolation and capability
 * checks remain F1 backend responsibilities; no provider call happens here.
 */
const github = GitHub({
  clientId: process.env.AUTH_GITHUB_ID ?? "",
  clientSecret: process.env.AUTH_GITHUB_SECRET ?? "",
});

export const { auth, signIn, signOut, store, isAuthenticated } = convexAuth({
  providers: [Anonymous, github],
});
