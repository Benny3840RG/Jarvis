import type { OidcIdentity } from "./oidcVerifier.js";

export type AuthenticatedPrincipal = Readonly<{
  kind: "oidc";
  subject: string;
  issuer: string;
  audience: string;
}>;

const principals = new WeakMap<object, AuthenticatedPrincipal>();

export function setAuthenticatedPrincipal(request: object, identity: OidcIdentity): void {
  if (principals.has(request)) {
    throw new Error("Authenticated request principal is already set.");
  }

  principals.set(
    request,
    Object.freeze({
      kind: "oidc" as const,
      subject: identity.subject,
      issuer: identity.issuer,
      audience: identity.audience,
    }),
  );
}

export function getAuthenticatedPrincipal(request: object): AuthenticatedPrincipal | undefined {
  return principals.get(request);
}
