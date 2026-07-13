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

type DueFields = { dueRaw?: string; dueAt?: number; dueTimezone?: string };

function cleanOptionalText(value: string | undefined, field: string): string | undefined {
  if (value === undefined) return undefined;
  const cleaned = value.trim();
  if (cleaned.length === 0) throw new Error(`${field} cannot be empty.`);
  return cleaned;
}

function validatedDue(args: DueFields): DueFields {
  const dueRaw = cleanOptionalText(args.dueRaw, "Reminder due text");
  const dueTimezone = cleanOptionalText(args.dueTimezone, "Reminder due timezone");
  if ((args.dueAt === undefined) !== (dueTimezone === undefined)) {
    throw new Error("A normalized reminder due value requires both a timestamp and timezone.");
  }
  if (args.dueAt !== undefined && dueRaw === undefined) {
    throw new Error("A normalized reminder due value requires the preserved raw text.");
  }
  if (args.dueAt !== undefined && !Number.isFinite(args.dueAt)) {
    throw new Error("Reminder due timestamp must be finite.");
  }

  return {
    ...(dueRaw === undefined ? {} : { dueRaw }),
    ...(args.dueAt === undefined ? {} : { dueAt: args.dueAt, dueTimezone: dueTimezone as string }),
  };
}

function existingDue(reminder: {
  due?: string;
  dueRaw?: string;
  dueAt?: number;
  dueTimezone?: string;
}): DueFields {
  const dueRaw = reminder.dueRaw ?? reminder.due;
  const hasNormalized = reminder.dueAt !== undefined && reminder.dueTimezone !== undefined;
  return {
    ...(dueRaw === undefined ? {} : { dueRaw }),
    ...(hasNormalized ? { dueAt: reminder.dueAt, dueTimezone: reminder.dueTimezone } : {}),
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

export const update = mutation({
  args: {
    serviceToken: v.string(),
    id: v.string(),
    title: v.optional(v.string()),
    dueRaw: v.optional(v.string()),
    dueAt: v.optional(v.number()),
    dueTimezone: v.optional(v.string()),
    clearDue: v.optional(v.boolean()),
  },
  returns: v.union(reminderValidator, v.null()),
  handler: async (ctx, args) => {
    const ownerId = requireOwner(args.serviceToken);
    const title = cleanOptionalText(args.title, "Reminder title");
    const clearDue = args.clearDue === true;
    const dueSupplied =
      args.dueRaw !== undefined || args.dueAt !== undefined || args.dueTimezone !== undefined;
    if (clearDue && dueSupplied) {
      throw new Error("Reminder update cannot set and clear the due value together.");
    }
    if (title === undefined && !clearDue && !dueSupplied) {
      throw new Error("Reminder update requires a title, due value, or clear-due request.");
    }
    const suppliedDue = dueSupplied ? validatedDue(args) : undefined;
    if (dueSupplied && suppliedDue?.dueRaw === undefined) {
      throw new Error("Reminder due update requires preserved raw text.");
    }

    const id = ctx.db.normalizeId("reminders", args.id);
    if (!id) return null;
    const reminder = await ctx.db.get("reminders", id);
    if (!reminder || reminder.ownerId !== ownerId) return null;

    const due = clearDue ? {} : (suppliedDue ?? existingDue(reminder));
    await ctx.db.replace("reminders", id, {
      ownerId,
      title: title ?? reminder.title,
      ...due,
      createdAt: reminder.createdAt,
    });
    return ctx.db.get("reminders", id);
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
