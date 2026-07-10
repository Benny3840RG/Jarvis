import { mutation, query } from "convex/server";
import { v } from "convex/values";

// assistantState.get -> returns the latest assistantState row (or null)
export const get = query({
  args: [],
  handler: async (ctx) => {
    // We expect a single document in assistantState to represent the current state.
    // A conventional pattern is to store a single row with a known id; here we fetch the
    // most recently updated row.
    const rows = await ctx.db.table("assistantState").all();
    if (!rows || rows.length === 0) return null;
    // assume the last row is the active one
    return rows[rows.length - 1];
  },
});

// assistantState.upsert -> accepts an object { state: Record<string, unknown> }
export const upsert = mutation({
  args: [v.object({ state: v.any() })],
  handler: async (ctx, [arg]) => {
    const now = new Date().toISOString();
    // Either insert a new row, or create a new row representing the latest state.
    const row = { state: arg.state, updatedAt: now };
    const id = await ctx.db.insert("assistantState", row);
    return { id, ...row };
  },
});
