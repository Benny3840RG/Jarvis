import { mutation, query } from "convex/server";
import { v } from "convex/values";

export const create = mutation({
  args: [v.object({ messages: v.any() })],
  handler: async (ctx, [arg]) => {
    const now = new Date().toISOString();
    const row = { messages: arg.messages, createdAt: now };
    const id = await ctx.db.insert("conversations", row);
    return { id, ...row };
  },
});

export const list = query({
  args: [],
  handler: async (ctx) => {
    const rows = await ctx.db.table("conversations").all();
    return rows;
  },
});

export const update = mutation({
  args: [v.object({ id: v.id("conversations"), patch: v.any() })],
  handler: async (ctx, [arg]) => {
    await ctx.db.patch("conversations", arg.id, arg.patch);
    return true;
  },
});

export const remove = mutation({
  args: [v.object({ id: v.id("conversations") })],
  handler: async (ctx, [arg]) => {
    await ctx.db.delete("conversations", arg.id);
    return true;
  },
});
