import { mutationGeneric, queryGeneric } from "convex/server";
import { v } from "convex/values";

const PRIMARY_KEY = "primary";

export const get = queryGeneric({
  args: {},
  handler: async (ctx) =>
    ctx.db
      .query("assistantState")
      .withIndex("by_key", (q) => q.eq("key", PRIMARY_KEY))
      .unique(),
});

export const upsert = mutationGeneric({
  args: { state: v.any() },
  handler: async (ctx, args) => {
    const existing = await ctx.db
      .query("assistantState")
      .withIndex("by_key", (q) => q.eq("key", PRIMARY_KEY))
      .unique();
    const updatedAt = Date.now();
    if (existing) {
      await ctx.db.patch("assistantState", existing._id, { state: args.state, updatedAt });
      return existing._id;
    }
    return ctx.db.insert("assistantState", {
      key: PRIMARY_KEY,
      state: args.state,
      updatedAt,
    });
  },
});
