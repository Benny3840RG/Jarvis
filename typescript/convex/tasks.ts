import { v } from "convex/values";

import { requireOwner } from "./authHelpers.js";
import { mutation, query } from "./_generated/server.js";

const taskValidator = v.object({
  _id: v.id("tasks"),
  _creationTime: v.number(),
  ownerId: v.string(),
  title: v.string(),
  completed: v.boolean(),
  category: v.string(),
  createdAt: v.number(),
});

export const create = mutation({
  args: { serviceToken: v.string(), title: v.string(), category: v.string() },
  returns: taskValidator,
  handler: async (ctx, args) => {
    const ownerId = requireOwner(args.serviceToken);
    const id = await ctx.db.insert("tasks", {
      ownerId,
      title: args.title,
      completed: false,
      category: args.category,
      createdAt: Date.now(),
    });
    const task = await ctx.db.get("tasks", id);
    if (!task) throw new Error("Task creation failed.");
    return task;
  },
});

export const list = query({
  args: { serviceToken: v.string() },
  returns: v.array(taskValidator),
  handler: async (ctx, args) => {
    const ownerId = requireOwner(args.serviceToken);
    return ctx.db.query("tasks").withIndex("by_owner", (q) => q.eq("ownerId", ownerId)).collect();
  },
});

export const complete = mutation({
  args: { serviceToken: v.string(), id: v.string() },
  returns: v.union(taskValidator, v.null()),
  handler: async (ctx, args) => {
    const ownerId = requireOwner(args.serviceToken);
    const id = ctx.db.normalizeId("tasks", args.id);
    if (!id) return null;
    const task = await ctx.db.get("tasks", id);
    if (!task || task.ownerId !== ownerId) return null;
    await ctx.db.patch("tasks", id, { completed: true });
    return ctx.db.get("tasks", id);
  },
});

export const remove = mutation({
  args: { serviceToken: v.string(), id: v.string() },
  returns: v.union(taskValidator, v.null()),
  handler: async (ctx, args) => {
    const ownerId = requireOwner(args.serviceToken);
    const id = ctx.db.normalizeId("tasks", args.id);
    if (!id) return null;
    const task = await ctx.db.get("tasks", id);
    if (!task || task.ownerId !== ownerId) return null;
    await ctx.db.delete("tasks", id);
    return task;
  },
});
