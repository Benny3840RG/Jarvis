import { defineSchema, defineTable } from "convex/schema";
import { v } from "convex/values";

export default defineSchema({
  tables: {
    tasks: defineTable({
      title: v.string(),
      completed: v.optional(v.boolean()),
      createdAt: v.optional(v.string()),
    }),

    reminders: defineTable({
      title: v.string(),
      due: v.optional(v.string()),
      createdAt: v.optional(v.string()),
    }),

    memories: defineTable({
      text: v.string(),
      createdAt: v.optional(v.string()),
    }),

    conversations: defineTable({
      messages: v.any(),
      createdAt: v.optional(v.string()),
    }),

    assistantState: defineTable({
      key: v.string(),
      state: v.any(),
      updatedAt: v.optional(v.string()),
    }),
  },
});
