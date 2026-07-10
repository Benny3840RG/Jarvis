import { query, mutation } from "convex/server";
import { v } from "convex/values";

export const get = query({
  args: {},
  handler: async (ctx) => {
    const existing = await ctx.db
      .query("assistantState")
      .withIndex("by_key", (q) => q.eq("key", "primary"))
      .unique();
    if (!existing) return null;
    return existing;
  },
});

export const upsert = mutation({
  args: {
    state: v.any(),
  },
  handler: async (ctx, args) => {
    const existing = await ctx.db
      .query("assistantState")
      .withIndex("by_key", (q) => q.eq("key", "primary"))
      .unique();
    const now = Date.now();
    if (existing) {
      await ctx.db.patch("assistantState", existing._id, { state: args.state, updatedAt: now });
      return { _id: existing._id, key: existing.key, state: args.state, updatedAt: now };
    } else {
      return await ctx.db.insert("assistantState", { key: "primary", state: args.state, updatedAt: now });
    }
  },
});
