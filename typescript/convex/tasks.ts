import { query, mutation } from "convex/server";
import { v } from "convex/values";

export const create = mutation({
  args: {
    title: v.string(),
  },
  handler: async (ctx, args) => {
    const now = Date.now();
    const row = { title: args.title, completed: false, createdAt: now };
    const id = await ctx.db.insert("tasks", row);
    return { _id: id, ...row };
  },
});

export const list = query({
  args: {},
  handler: async (ctx) => {
    return await ctx.db.table("tasks").all();
  },
});

export const update = mutation({
  args: {
    id: v.id("tasks"),
    patch: v.any(),
  },
  handler: async (ctx, args) => {
    await ctx.db.patch("tasks", args.id, args.patch);
    return true;
  },
});

export const remove = mutation({
  args: {
    id: v.id("tasks"),
  },
  handler: async (ctx, args) => {
    await ctx.db.delete("tasks", args.id);
    return true;
  },
});
