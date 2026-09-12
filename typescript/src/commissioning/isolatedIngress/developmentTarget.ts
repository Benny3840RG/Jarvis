/** Fail closed before constructing clients or issuing commissioning effects. */
export function commissioningDevelopmentUrl(env: NodeJS.ProcessEnv): string {
  const deployment = /^dev:([a-z0-9-]+)$/.exec(env.CONVEX_DEPLOYMENT?.trim() ?? "");
  if (!deployment) throw new Error("Commissioning requires CONVEX_DEPLOYMENT=dev:<name>.");
  const expected = `https://${deployment[1]}.convex.cloud`;
  if (env.CONVEX_URL !== expected && env.CONVEX_URL !== `${expected}/`) {
    throw new Error("CONVEX_URL must exactly match the named development deployment.");
  }
  return expected;
}
