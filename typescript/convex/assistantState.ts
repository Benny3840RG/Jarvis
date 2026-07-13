import { v } from "convex/values";

import { requireOwner } from "./authHelpers.js";
import type { Doc, Id } from "./_generated/dataModel.js";
import { mutation, query } from "./_generated/server.js";

const PRIMARY_KEY = "primary";

const assistantStateValidator = v.object({
  _id: v.id("assistantState"),
  _creationTime: v.number(),
  ownerId: v.string(),
  key: v.string(),
  state: v.any(),
  updatedAt: v.number(),
});

const taskValidator = v.object({
  _id: v.id("tasks"),
  _creationTime: v.number(),
  ownerId: v.string(),
  title: v.string(),
  completed: v.boolean(),
  category: v.string(),
  createdAt: v.number(),
});

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

const restoreTaskValidator = v.object({
  sourceId: v.string(),
  title: v.string(),
  completed: v.boolean(),
  category: v.string(),
});

const restoreReminderValidator = v.object({
  sourceId: v.string(),
  title: v.string(),
  dueRaw: v.optional(v.string()),
  dueAt: v.optional(v.number()),
  dueTimezone: v.optional(v.string()),
});

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function remapIds(value: unknown, ids: ReadonlyMap<string, string>): unknown {
  if (typeof value === "string") return ids.get(value) ?? value;
  if (Array.isArray(value)) return value.map((entry) => remapIds(entry, ids));
  if (isRecord(value)) {
    return Object.fromEntries(
      Object.entries(value).map(([key, entry]) => [key, remapIds(entry, ids)]),
    );
  }
  return value;
}

function validatedDue(args: { dueRaw?: string; dueAt?: number; dueTimezone?: string }): {
  dueRaw?: string;
  dueAt?: number;
  dueTimezone?: string;
} {
  const dueRaw = args.dueRaw?.trim();
  const dueTimezone = args.dueTimezone?.trim();
  if (args.dueRaw !== undefined && dueRaw?.length === 0) {
    throw new Error("Reminder due text cannot be empty.");
  }
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

function assertUniqueSourceIds(records: readonly { sourceId: string }[], name: string): void {
  const ids = new Set<string>();
  for (const record of records) {
    if (ids.has(record.sourceId)) {
      throw new Error(`Restore contains a duplicate ${name} source id: ${record.sourceId}.`);
    }
    ids.add(record.sourceId);
  }
}

export const get = query({
  args: { serviceToken: v.string() },
  returns: v.union(assistantStateValidator, v.null()),
  handler: async (ctx, args) => {
    const ownerId = requireOwner(args.serviceToken);
    return ctx.db
      .query("assistantState")
      .withIndex("by_owner_key", (q) => q.eq("ownerId", ownerId).eq("key", PRIMARY_KEY))
      .unique();
  },
});

export const upsert = mutation({
  args: { serviceToken: v.string(), state: v.any() },
  returns: v.id("assistantState"),
  handler: async (ctx, args) => {
    const ownerId = requireOwner(args.serviceToken);
    const existing = await ctx.db
      .query("assistantState")
      .withIndex("by_owner_key", (q) => q.eq("ownerId", ownerId).eq("key", PRIMARY_KEY))
      .unique();
    const updatedAt = Date.now();
    if (existing) {
      await ctx.db.patch("assistantState", existing._id, { state: args.state, updatedAt });
      return existing._id;
    }
    return ctx.db.insert("assistantState", {
      ownerId,
      key: PRIMARY_KEY,
      state: args.state,
      updatedAt,
    });
  },
});

export const snapshot = query({
  args: { serviceToken: v.string() },
  returns: v.object({
    state: v.any(),
    tasks: v.array(taskValidator),
    reminders: v.array(reminderValidator),
  }),
  handler: async (ctx, args) => {
    const ownerId = requireOwner(args.serviceToken);
    const [stateRow, tasks, reminders] = await Promise.all([
      ctx.db
        .query("assistantState")
        .withIndex("by_owner_key", (q) => q.eq("ownerId", ownerId).eq("key", PRIMARY_KEY))
        .unique(),
      ctx.db
        .query("tasks")
        .withIndex("by_owner", (q) => q.eq("ownerId", ownerId))
        .collect(),
      ctx.db
        .query("reminders")
        .withIndex("by_owner", (q) => q.eq("ownerId", ownerId))
        .collect(),
    ]);
    return {
      state: isRecord(stateRow?.state) ? stateRow.state : {},
      tasks,
      reminders,
    };
  },
});

export const restoreEmpty = mutation({
  args: {
    serviceToken: v.string(),
    state: v.any(),
    tasks: v.array(restoreTaskValidator),
    reminders: v.array(restoreReminderValidator),
  },
  returns: v.object({
    state: v.any(),
    tasks: v.array(taskValidator),
    reminders: v.array(reminderValidator),
    taskIds: v.array(v.object({ sourceId: v.string(), targetId: v.id("tasks") })),
    reminderIds: v.array(v.object({ sourceId: v.string(), targetId: v.id("reminders") })),
  }),
  handler: async (ctx, args) => {
    const ownerId = requireOwner(args.serviceToken);
    if (!isRecord(args.state)) throw new Error("Backup assistant state must be an object.");
    assertUniqueSourceIds(args.tasks, "task");
    assertUniqueSourceIds(args.reminders, "reminder");

    const [existingState, existingTask, existingReminder] = await Promise.all([
      ctx.db
        .query("assistantState")
        .withIndex("by_owner_key", (q) => q.eq("ownerId", ownerId).eq("key", PRIMARY_KEY))
        .unique(),
      ctx.db
        .query("tasks")
        .withIndex("by_owner", (q) => q.eq("ownerId", ownerId))
        .first(),
      ctx.db
        .query("reminders")
        .withIndex("by_owner", (q) => q.eq("ownerId", ownerId))
        .first(),
    ]);
    if (existingState || existingTask || existingReminder) {
      throw new Error("Restore refused: the target provider is not empty.");
    }

    const taskIds = new Map<string, Id<"tasks">>();
    const reminderIds = new Map<string, Id<"reminders">>();
    const restoredTasks: Array<Doc<"tasks">> = [];
    const restoredReminders: Array<Doc<"reminders">> = [];

    for (const source of args.tasks) {
      const id = await ctx.db.insert("tasks", {
        ownerId,
        title: source.title,
        completed: source.completed,
        category: source.category,
        createdAt: Date.now(),
      });
      const task = await ctx.db.get("tasks", id);
      if (!task) throw new Error(`Failed to restore task: ${source.title}`);
      taskIds.set(source.sourceId, id);
      restoredTasks.push(task);
    }

    for (const source of args.reminders) {
      const due = validatedDue(source);
      const id = await ctx.db.insert("reminders", {
        ownerId,
        title: source.title,
        ...due,
        createdAt: Date.now(),
      });
      const reminder = await ctx.db.get("reminders", id);
      if (!reminder) throw new Error(`Failed to restore reminder: ${source.title}`);
      reminderIds.set(source.sourceId, id);
      restoredReminders.push(reminder);
    }

    const allIds = new Map<string, string>();
    for (const [sourceId, targetId] of taskIds) allIds.set(sourceId, targetId);
    for (const [sourceId, targetId] of reminderIds) allIds.set(sourceId, targetId);
    const restoredState = remapIds(args.state, allIds);
    await ctx.db.insert("assistantState", {
      ownerId,
      key: PRIMARY_KEY,
      state: restoredState,
      updatedAt: Date.now(),
    });

    return {
      state: restoredState,
      tasks: restoredTasks,
      reminders: restoredReminders,
      taskIds: [...taskIds].map(([sourceId, targetId]) => ({ sourceId, targetId })),
      reminderIds: [...reminderIds].map(([sourceId, targetId]) => ({ sourceId, targetId })),
    };
  },
});
