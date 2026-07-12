type AuthContext = {
  auth: {
    getUserIdentity(): Promise<{ tokenIdentifier: string } | null>;
  };
};

export async function requireOwner(ctx: AuthContext): Promise<string> {
  const identity = await ctx.auth.getUserIdentity();
  if (!identity) throw new Error("Unauthenticated: a valid identity token is required.");
  return identity.tokenIdentifier;
}
