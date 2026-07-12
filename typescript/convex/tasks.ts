import { mutationGeneric, queryGeneric } from "convex/server";
import { v } from "convex/values";

export const create = mutationGeneric({
  args: { title: v.string(), category: v.string() },
  handler: async (ctx, args) => {
    const row = {
      title: args.title,
      category: args.category,
      completed: false,
      createdAt: Date.now(),
    };
    const id = await ctx.db.insert("tasks", row);
    return { _id: id, ...row };
  },
});

export const list = queryGeneric({
  args: {},
  handler: async (ctx) => ctx.db.query("tasks").collect(),
});

export const update = mutationGeneric({
  args: {
    id: v.id("tasks"),
    title: v.optional(v.string()),
    category: v.optional(v.string()),
    completed: v.optional(v.boolean()),
  },
  handler: async (ctx, args) => {
    const patch: { title?: string; category?: string; completed?: boolean } = {};
    if (args.title !== undefined) patch.title = args.title;
    if (args.category !== undefined) patch.category = args.category;
    if (args.completed !== undefined) patch.completed = args.completed;
    await ctx.db.patch("tasks", args.id, patch);
    return ctx.db.get(args.id);
  },
});

export const remove = mutationGeneric({
  args: { id: v.id("tasks") },
  handler: async (ctx, args) => {
    await ctx.db.delete("tasks", args.id);
    return true;
  },
});
