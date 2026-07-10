import { mutation, query } from "convex/server";
import { v } from "convex/values";

// assistantState.get -> returns the assistantState row with key === "primary" or null
export const get = query({
  args: [],
  handler: async (ctx) => {
    const rows = await ctx.db.table("assistantState").all();
    if (!rows || rows.length === 0) return null;
    const found = rows.find((r: any) => r.key === "primary");
    if (!found) return null;
    return found;
  },
});

// assistantState.upsert -> accepts an object { state: Record<string, unknown> }
// and patches the existing primary row or inserts a new one.
export const upsert = mutation({
  args: [v.object({ state: v.any() })],
  handler: async (ctx, [arg]) => {
    const rows = await ctx.db.table("assistantState").all();
    const existing = rows.find((r: any) => r.key === "primary");
    const now = new Date().toISOString();
    if (existing) {
      await ctx.db.patch("assistantState", existing._id, { state: arg.state, updatedAt: now });
      return { id: existing._id, state: arg.state, updatedAt: now };
    } else {
      const row = { key: "primary", state: arg.state, updatedAt: now };
      const id = await ctx.db.insert("assistantState", row);
      return { id, ...row };
    }
  },
});
