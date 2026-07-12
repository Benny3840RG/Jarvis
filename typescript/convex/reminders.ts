import { mutationGeneric, queryGeneric } from "convex/server";
import { v } from "convex/values";

import { requireOwner } from "./authHelpers.js";

const reminderValidator = v.object({
  _id: v.id("reminders"),
  _creationTime: v.number(),
  ownerId: v.string(),
  title: v.string(),
  due: v.optional(v.string()),
  createdAt: v.number(),
});

export const create = mutationGeneric({
  args: { serviceToken: v.string(), title: v.string(), due: v.optional(v.string()) },
  returns: reminderValidator,
  handler: async (ctx, args) => {
    const ownerId = requireOwner(args.serviceToken);
    const id = await ctx.db.insert("reminders", {
      ownerId,
      title: args.title,
      ...(args.due === undefined ? {} : { due: args.due }),
      createdAt: Date.now(),
    });
    const reminder = await ctx.db.get("reminders", id);
    if (!reminder) throw new Error("Reminder creation failed.");
    return reminder;
  },
});

export const list = queryGeneric({
  args: { serviceToken: v.string() },
  returns: v.array(reminderValidator),
  handler: async (ctx, args) => {
    const ownerId = requireOwner(args.serviceToken);
    return ctx.db
      .query("reminders")
      .withIndex("by_owner", (q) => q.eq("ownerId", ownerId))
      .collect();
  },
});

export const remove = mutationGeneric({
  args: { serviceToken: v.string(), id: v.string() },
  returns: v.union(reminderValidator, v.null()),
  handler: async (ctx, args) => {
    const ownerId = requireOwner(args.serviceToken);
    const id = ctx.db.normalizeId("reminders", args.id);
    if (!id) return null;
    const reminder = await ctx.db.get("reminders", id);
    if (!reminder || reminder.ownerId !== ownerId) return null;
    await ctx.db.delete("reminders", id);
    return reminder;
  },
});
