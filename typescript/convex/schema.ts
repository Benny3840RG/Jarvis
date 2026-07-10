import { defineSchema, defineTable } from "convex/schema";
import { v } from "convex/values";

// Define the Convex schema for the repository. This file intentionally uses
// the server-side schema builders from the Convex SDK. After installing
// convex locally you must run `npx convex codegen` to generate the client API
// used by the Node CLI.

export default defineSchema({
  tables: {
    tasks: defineTable({
      // A short title for the task
      title: v.string(),
      // Optional completed flag
      completed: v.optional(v.boolean()),
      // ISO timestamp
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
      messages: v.any(), // flexible array of message objects; use v.any() because messages are structured
      createdAt: v.optional(v.string()),
    }),

    assistantState: defineTable({
      // store the whole assistant state as a JSON-like object
      state: v.any(),
      updatedAt: v.optional(v.string()),
    }),
  },
});
