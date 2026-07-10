import { mutation, query } from "convex/server";
import { v } from "convex/values";

export const create = mutation({
  args: [v.object({ text: v.string() })],
  handler: async (ctx, [arg]) => {
    const now = new Date().toISOString();
    const row = { text: arg.text, createdAt: now };
    const id = await ctx.db.insert("memories", row);
    return { id, ...row };
  },
});

export const list = query({
  args: [],
  handler: async (ctx) => {
    const rows = await ctx.db.table("memories").all();
    return rows;
  },
});

export const update = mutation({
  args: [v.object({ id: v.id("memories"), patch: v.any() })],
  handler: async (ctx, [arg]) => {
    await ctx.db.patch("memories", arg.id, arg.patch);
    return true;
  },
});

export const remove = mutation({
  args: [v.object({ id: v.id("memories") })],
  handler: async (ctx, [arg]) => {
    await ctx.db.delete("memories", arg.id);
    return true;
  },
});
