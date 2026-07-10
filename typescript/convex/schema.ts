import { defineSchema, defineTable } from "convex/server";
import { v } from "convex/values";

export default defineSchema({
  tasks: defineTable({
    title: v.string(),
    completed: v.optional(v.boolean()),
    createdAt: v.optional(v.number()),
  }),

  reminders: defineTable({
    title: v.string(),
    due: v.optional(v.string()),
    createdAt: v.optional(v.number()),
  }),

  memories: defineTable({
    text: v.string(),
    createdAt: v.optional(v.number()),
  }),

  conversations: defineTable({
    messages: v.any(),
    createdAt: v.optional(v.number()),
  }),

  assistantState: defineTable({
    key: v.string(),
    state: v.any(),
    updatedAt: v.optional(v.number()),
  }).index("by_key", ["key"]),
});
