import { query, mutation } from "convex/server";
import { v } from "convex/values";

export const create = mutation({
  args: {
    messages: v.any(),
  },
  handler: async (ctx, args) => {
    const now = Date.now();
    const row = { messages: args.messages, createdAt: now };
    const id = await ctx.db.insert("conversations", row);
    return { _id: id, ...row };
  },
});

export const list = query({
  args: {},
  handler: async (ctx) => {
    return await ctx.db.table("conversations").all();
  },
});

export const update = mutation({
  args: {
    id: v.id("conversations"),
    patch: v.any(),
  },
  handler: async (ctx, args) => {
    await ctx.db.patch("conversations", args.id, args.patch);
    return true;
  },
});

export const remove = mutation({
  args: {
    id: v.id("conversations"),
  },
  handler: async (ctx, args) => {
    await ctx.db.delete("conversations", args.id);
    return true;
  },
});
