import { defineSchema, defineTable } from "convex/server";
import { v } from "convex/values";

export default defineSchema({
  tasks: defineTable({
    ownerId: v.string(),
    title: v.string(),
    completed: v.boolean(),
    category: v.string(),
    createdAt: v.number(),
  }).index("by_owner", ["ownerId"]),
  reminders: defineTable({
    ownerId: v.string(),
    title: v.string(),
    due: v.optional(v.string()),
    dueRaw: v.optional(v.string()),
    dueAt: v.optional(v.number()),
    dueTimezone: v.optional(v.string()),
    createdAt: v.number(),
  }).index("by_owner", ["ownerId"]),
  assistantState: defineTable({
    ownerId: v.string(),
    key: v.string(),
    state: v.any(),
    updatedAt: v.number(),
  }).index("by_owner_key", ["ownerId", "key"]),
});
