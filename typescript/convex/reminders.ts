import { query, mutation } from "convex/server";
import { v } from "convex/values";

export const create = mutation({
  args: {
    title: v.string(),
    due: v.optional(v.string()),
  },
  handler: async (ctx, args) => {
    const now = Date.now();
    const row = { title: args.title, due: args.due, createdAt: now };
    const id = await ctx.db.insert("reminders", row);
    return { _id: id, ...row };
  },
});

export const list = query({
  args: {},
  handler: async (ctx) => {
    return await ctx.db.table("reminders").all();
  },
});

export const update = mutation({
  args: {
    id: v.id("reminders"),
    patch: v.any(),
  },
  handler: async (ctx, args) => {
    await ctx.db.patch("reminders", args.id, args.patch);
    return true;
  },
});

export const remove = mutation({
  args: {
    id: v.id("reminders"),
  },
  handler: async (ctx, args) => {
    await ctx.db.delete("reminders", args.id);
    return true;
  },
});
