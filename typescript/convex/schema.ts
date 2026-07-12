import { defineSchema, defineTable } from "convex/server";
import { v } from "convex/values";

const conversationMessage = v.object({
  role: v.string(),
  content: v.string(),
  createdAt: v.optional(v.number()),
});

export default defineSchema({
  tasks: defineTable({
    title: v.string(),
    completed: v.boolean(),
    createdAt: v.number(),
  }),
  reminders: defineTable({
    title: v.string(),
    due: v.optional(v.string()),
    createdAt: v.number(),
  }),
  memories: defineTable({
    text: v.string(),
    createdAt: v.number(),
  }),
  conversations: defineTable({
    messages: v.array(conversationMessage),
    createdAt: v.number(),
  }),
  assistantState: defineTable({
    key: v.string(),
    state: v.any(),
    updatedAt: v.number(),
  }).index("by_key", ["key"]),
});
