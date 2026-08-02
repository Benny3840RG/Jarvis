import type { MutationCtx } from "./_generated/server.js";

export async function requireOwnedBuildId(
  ctx: MutationCtx,
  ownerId: string,
  value: string,
): Promise<string> {
  const cleaned = value.trim();
  if (cleaned.length === 0) throw new Error("Build ID cannot be empty.");

  const id = ctx.db.normalizeId("builds", cleaned);
  if (!id) throw new Error("Build does not exist.");

  const build = await ctx.db.get("builds", id);
  if (!build || build.ownerId !== ownerId) {
    throw new Error("Build does not exist.");
  }

  return id;
}
