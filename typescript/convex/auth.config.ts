import type { AuthConfig } from "convex/server";

const domain = process.env.CONVEX_AUTH_ISSUER;
const applicationID = process.env.CONVEX_AUTH_AUDIENCE;

if (!domain || !applicationID) {
  throw new Error(
    "Convex auth requires CONVEX_AUTH_ISSUER and CONVEX_AUTH_AUDIENCE to be configured.",
  );
}

export default {
  providers: [{ domain, applicationID }],
} satisfies AuthConfig;
