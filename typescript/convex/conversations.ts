import { mutationGeneric, queryGeneric } from "convex/server";
import { v } from "convex/values";

const messageValidator = v.object({
  role: v.string(),
  content: v.string(),
  createdAt: v.optional(v.number()),
});

export const create = mutationGeneric({
  args: { messages: v.array(messageValidator) },
  handler: async (ctx, args) => {
    const row = { messages: args.messages, createdAt: Date.now() };
    const id = await ctx.db.insert("conversations", row);
    return { _id: id, ...row };
  },
});

export const list = queryGeneric({
  args: {},
  handler: async (ctx) => ctx.db.query("conversations").collect(),
});

export const update = mutationGeneric({
  args: { id: v.id("conversations"), messages: v.array(messageValidator) },
  handler: async (ctx, args) => {
    await ctx.db.patch("conversations", args.id, { messages: args.messages });
    return true;
  },
});

export const remove = mutationGeneric({
  args: { id: v.id("conversations") },
  handler: async (ctx, args) => {
    await ctx.db.delete("conversations", args.id);
    return true;
  },
});
