import { query, mutation } from "convex/server";
import { v } from "convex/values";

export const create = mutation({
  args: {
    text: v.string(),
  },
  handler: async (ctx, args) => {
    const now = Date.now();
    const row = { text: args.text, createdAt: now };
    const id = await ctx.db.insert("memories", row);
    return { _id: id, ...row };
  },
});

export const list = query({
  args: {},
  handler: async (ctx) => {
    return await ctx.db.table("memories").all();
  },
});

export const update = mutation({
  args: {
    id: v.id("memories"),
    patch: v.any(),
  },
  handler: async (ctx, args) => {
    await ctx.db.patch("memories", args.id, args.patch);
    return true;
  },
});

export const remove = mutation({
  args: {
    id: v.id("memories"),
  },
  handler: async (ctx, args) => {
    await ctx.db.delete("memories", args.id);
    return true;
  },
});
