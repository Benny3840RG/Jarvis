import { mutationGeneric, queryGeneric } from "convex/server";
import { v } from "convex/values";

export const create = mutationGeneric({
  args: { title: v.string(), due: v.optional(v.string()) },
  handler: async (ctx, args) => {
    const row = { title: args.title, due: args.due, createdAt: Date.now() };
    const id = await ctx.db.insert("reminders", row);
    return { _id: id, ...row };
  },
});

export const list = queryGeneric({
  args: {},
  handler: async (ctx) => ctx.db.query("reminders").collect(),
});

export const update = mutationGeneric({
  args: {
    id: v.id("reminders"),
    title: v.optional(v.string()),
    due: v.optional(v.string()),
  },
  handler: async (ctx, args) => {
    const patch: { title?: string; due?: string } = {};
    if (args.title !== undefined) patch.title = args.title;
    if (args.due !== undefined) patch.due = args.due;
    await ctx.db.patch("reminders", args.id, patch);
    return ctx.db.get(args.id);
  },
});

export const remove = mutationGeneric({
  args: { id: v.id("reminders") },
  handler: async (ctx, args) => {
    const existing = await ctx.db.get(args.id);
    if (!existing) return false;
    await ctx.db.delete("reminders", args.id);
    return true;
  },
});
