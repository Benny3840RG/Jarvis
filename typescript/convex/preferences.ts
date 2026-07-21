import { v } from "convex/values";

import { requireOwner } from "./authHelpers.js";
import { mutation, query } from "./_generated/server.js";

const preferenceValidator = v.object({
  _id: v.id("preferences"),
  _creationTime: v.number(),
  ownerId: v.string(),
  key: v.string(),
  value: v.string(),
  category: v.optional(v.string()),
  createdAt: v.number(),
  updatedAt: v.number(),
});

function requireText(value: string, field: string): string {
  const cleaned = value.trim();
  if (cleaned.length === 0) throw new Error(`${field} cannot be empty.`);
  return cleaned;
}

function cleanOptionalText(value: string | undefined, field: string): string | undefined {
  if (value === undefined) return undefined;
  const cleaned = value.trim();
  if (cleaned.length === 0) throw new Error(`${field} cannot be empty.`);
  return cleaned;
}

export const list = query({
  args: { serviceToken: v.string() },
  returns: v.array(preferenceValidator),
  handler: async (ctx, args) => {
    const ownerId = requireOwner(args.serviceToken);
    return ctx.db
      .query("preferences")
      .withIndex("by_owner", (q) => q.eq("ownerId", ownerId))
      .collect();
  },
});

export const get = query({
  args: { serviceToken: v.string(), id: v.string() },
  returns: v.union(preferenceValidator, v.null()),
  handler: async (ctx, args) => {
    const ownerId = requireOwner(args.serviceToken);
    const id = ctx.db.normalizeId("preferences", args.id);
    if (!id) return null;
    const preference = await ctx.db.get("preferences", id);
    return preference && preference.ownerId === ownerId ? preference : null;
  },
});

export const create = mutation({
  args: {
    serviceToken: v.string(),
    key: v.string(),
    value: v.string(),
    category: v.optional(v.string()),
  },
  returns: preferenceValidator,
  handler: async (ctx, args) => {
    const ownerId = requireOwner(args.serviceToken);
    const now = Date.now();
    const category = cleanOptionalText(args.category, "Preference category");
    const id = await ctx.db.insert("preferences", {
      ownerId,
      key: requireText(args.key, "Preference key"),
      value: requireText(args.value, "Preference value"),
      ...(category === undefined ? {} : { category }),
      createdAt: now,
      updatedAt: now,
    });
    const preference = await ctx.db.get("preferences", id);
    if (!preference) throw new Error("Preference creation failed.");
    return preference;
  },
});

export const update = mutation({
  args: {
    serviceToken: v.string(),
    id: v.string(),
    key: v.optional(v.string()),
    value: v.optional(v.string()),
    category: v.optional(v.string()),
    clearCategory: v.optional(v.boolean()),
  },
  returns: v.union(preferenceValidator, v.null()),
  handler: async (ctx, args) => {
    const ownerId = requireOwner(args.serviceToken);

    const key = cleanOptionalText(args.key, "Preference key");
    const value = cleanOptionalText(args.value, "Preference value");
    const category = cleanOptionalText(args.category, "Preference category");

    const patch: {
      key?: string;
      value?: string;
      category?: string | undefined;
      updatedAt: number;
    } = { updatedAt: Date.now() };
    if (key !== undefined) patch.key = key;
    if (value !== undefined) patch.value = value;
    if (args.clearCategory) patch.category = undefined;
    else if (category !== undefined) patch.category = category;

    const changedKeys = Object.keys(patch).filter((k) => k !== "updatedAt");
    if (changedKeys.length === 0) {
      throw new Error("Preference update requires at least one changed field.");
    }

    const id = ctx.db.normalizeId("preferences", args.id);
    if (!id) return null;
    const preference = await ctx.db.get("preferences", id);
    if (!preference || preference.ownerId !== ownerId) return null;
    await ctx.db.patch("preferences", id, patch);
    return ctx.db.get("preferences", id);
  },
});

export const remove = mutation({
  args: { serviceToken: v.string(), id: v.string() },
  returns: v.union(preferenceValidator, v.null()),
  handler: async (ctx, args) => {
    const ownerId = requireOwner(args.serviceToken);
    const id = ctx.db.normalizeId("preferences", args.id);
    if (!id) return null;
    const preference = await ctx.db.get("preferences", id);
    if (!preference || preference.ownerId !== ownerId) return null;
    await ctx.db.delete("preferences", id);
    return preference;
  },
});
