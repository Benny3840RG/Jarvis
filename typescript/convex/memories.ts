import { mutationGeneric, queryGeneric } from "convex/server";
import { v } from "convex/values";

export const create = mutationGeneric({
  args: { text: v.string() },
  handler: async (ctx, args) => {
    const row = { text: args.text, createdAt: Date.now() };
    const id = await ctx.db.insert("memories", row);
    return { _id: id, ...row };
  },
});

export const list = queryGeneric({
  args: {},
  handler: async (ctx) => ctx.db.query("memories").collect(),
});

export const update = mutationGeneric({
  args: { id: v.id("memories"), text: v.string() },
  handler: async (ctx, args) => {
    await ctx.db.patch("memories", args.id, { text: args.text });
    return true;
  },
});

export const remove = mutationGeneric({
  args: { id: v.id("memories") },
  handler: async (ctx, args) => {
    await ctx.db.delete("memories", args.id);
    return true;
  },
});
