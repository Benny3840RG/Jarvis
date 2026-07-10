import { mutation, query } from "convex/server";
import { v } from "convex/values";

// Server-side Convex functions for tasks.

export const create = mutation({
  args: [v.object({ title: v.string() })],
  handler: async (ctx, [arg]) => {
    const now = new Date().toISOString();
    const row = {
      title: arg.title,
      completed: false,
      createdAt: now,
    };
    const id = await ctx.db.insert("tasks", row);
    return { id, ...row };
  },
});

export const list = query({
  args: [],
  handler: async (ctx) => {
    // Convex provides table iteration via ctx.db.table or ctx.db.query depending on SDK version.
    // We use ctx.db.table("tasks").collect() here as a conventional pattern.
    const rows = await ctx.db.table("tasks").all();
    return rows;
  },
});

export const update = mutation({
  args: [v.object({ id: v.id("tasks"), patch: v.any() })],
  handler: async (ctx, [arg]) => {
    await ctx.db.patch("tasks", arg.id, arg.patch);
    return true;
  },
});

export const remove = mutation({
  args: [v.object({ id: v.id("tasks") })],
  handler: async (ctx, [arg]) => {
    await ctx.db.delete("tasks", arg.id);
    return true;
  },
});
