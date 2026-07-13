import { v } from "convex/values";

import { requireOwner } from "./authHelpers.js";
import { mutation, query } from "./_generated/server.js";

const reminderValidator = v.object({
  _id: v.id("reminders"),
  _creationTime: v.number(),
  ownerId: v.string(),
  title: v.string(),
  due: v.optional(v.string()),
  dueRaw: v.optional(v.string()),
  dueAt: v.optional(v.number()),
  dueTimezone: v.optional(v.string()),
  createdAt: v.number(),
});

function validatedDue(args: {
  dueRaw?: string;
  dueAt?: number;
  dueTimezone?: string;
}): { dueRaw?: string; dueAt?: number; dueTimezone?: string } {
  if (args.dueRaw !== undefined && args.dueRaw.trim().length === 0) {
    throw new Error("Reminder due text cannot be empty.");
  }
  if ((args.dueAt === undefined) !== (args.dueTimezone === undefined)) {
    throw new Error("A normalized reminder due value requires both a timestamp and timezone.");
  }
  if (args.dueAt !== undefined && args.dueRaw === undefined) {
    throw new Error("A normalized reminder due value requires the preserved raw text.");
  }
  if (args.dueAt !== undefined && !Number.isFinite(args.dueAt)) {
    throw new Error("Reminder due timestamp must be finite.");
  }
  if (args.dueTimezone !== undefined && args.dueTimezone.trim().length === 0) {
    throw new Error("Reminder due timezone cannot be empty.");
  }

  return {
    ...(args.dueRaw === undefined ? {} : { dueRaw: args.dueRaw.trim() }),
    ...(args.dueAt === undefined
      ? {}
      : { dueAt: args.dueAt, dueTimezone: args.dueTimezone?.trim() }),
  };
}

export const create = mutation({
  args: {
    serviceToken: v.string(),
    title: v.string(),
    dueRaw: v.optional(v.string()),
    dueAt: v.optional(v.number()),
    dueTimezone: v.optional(v.string()),
  },
  returns: reminderValidator,
  handler: async (ctx, args) => {
    const ownerId = requireOwner(args.serviceToken);
    const due = validatedDue(args);
    const id = await ctx.db.insert("reminders", {
      ownerId,
      title: args.title,
      ...due,
      createdAt: Date.now(),
    });
    const reminder = await ctx.db.get("reminders", id);
    if (!reminder) throw new Error("Reminder creation failed.");
    return reminder;
  },
});

export const list = query({
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

export const remove = mutation({
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
