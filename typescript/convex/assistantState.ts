import { mutationGeneric, queryGeneric } from "convex/server";
import { v } from "convex/values";

import { requireOwner } from "./authHelpers.js";

const PRIMARY_KEY = "primary";

const assistantStateValidator = v.object({
  _id: v.id("assistantState"),
  _creationTime: v.number(),
  ownerId: v.string(),
  key: v.string(),
  state: v.any(),
  updatedAt: v.number(),
});

export const get = queryGeneric({
  args: { serviceToken: v.string() },
  returns: v.union(assistantStateValidator, v.null()),
  handler: async (ctx, args) => {
    const ownerId = requireOwner(args.serviceToken);
    return ctx.db
      .query("assistantState")
      .withIndex("by_owner_key", (q) => q.eq("ownerId", ownerId))
      .filter((q) => q.eq(q.field("key"), PRIMARY_KEY))
      .unique();
  },
});

export const upsert = mutationGeneric({
  args: { serviceToken: v.string(), state: v.any() },
  returns: v.id("assistantState"),
  handler: async (ctx, args) => {
    const ownerId = requireOwner(args.serviceToken);
    const existing = await ctx.db
      .query("assistantState")
      .withIndex("by_owner_key", (q) => q.eq("ownerId", ownerId))
      .filter((q) => q.eq(q.field("key"), PRIMARY_KEY))
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
