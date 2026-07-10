import { mutation, query } from "convex/server";
import { v } from "convex/values";

export const create = mutation({
  args: [v.object({ title: v.string(), due: v.optional(v.string()) })],
  handler: async (ctx, [arg]) => {
    const now = new Date().toISOString();
    const row = { title: arg.title, due: arg.due, createdAt: now };
    const id = await ctx.db.insert("reminders", row);
    return { id, ...row };
  },
});

export const list = query({
  args: [],
  handler: async (ctx) => {
    const rows = await ctx.db.table("reminders").all();
    return rows;
  },
});

export const update = mutation({
  args: [v.object({ id: v.id("reminders"), patch: v.any() })],
  handler: async (ctx, [arg]) => {
    await ctx.db.patch("reminders", arg.id, arg.patch);
    return true;
  },
});

export const remove = mutation({
  args: [v.object({ id: v.id("reminders") })],
  handler: async (ctx, [arg]) => {
    await ctx.db.delete("reminders", arg.id);
    return true;
  },
});
