import { v } from "convex/values";

import { requireOwner } from "./authHelpers.js";
import { mutation, query } from "./_generated/server.js";

const assetValidator = v.object({
  _id: v.id("assets"),
  _creationTime: v.number(),
  ownerId: v.string(),
  name: v.string(),
  kind: v.string(),
  serviceIntervalDays: v.optional(v.number()),
  lastServicedAt: v.optional(v.number()),
  notes: v.optional(v.string()),
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

function validServiceInterval(value: number): number {
  if (!Number.isInteger(value) || value <= 0) {
    throw new Error("Asset serviceIntervalDays must be a positive whole number of days.");
  }
  return value;
}

function validTimestamp(value: number): number {
  if (!Number.isFinite(value)) {
    throw new Error("Asset lastServicedAt must be a finite timestamp in milliseconds.");
  }
  return value;
}

export const list = query({
  args: { serviceToken: v.string() },
  returns: v.array(assetValidator),
  handler: async (ctx, args) => {
    const ownerId = requireOwner(args.serviceToken);
    return ctx.db
      .query("assets")
      .withIndex("by_owner", (q) => q.eq("ownerId", ownerId))
      .collect();
  },
});

export const get = query({
  args: { serviceToken: v.string(), id: v.string() },
  returns: v.union(assetValidator, v.null()),
  handler: async (ctx, args) => {
    const ownerId = requireOwner(args.serviceToken);
    const id = ctx.db.normalizeId("assets", args.id);
    if (!id) return null;
    const asset = await ctx.db.get("assets", id);
    return asset && asset.ownerId === ownerId ? asset : null;
  },
});

export const create = mutation({
  args: {
    serviceToken: v.string(),
    name: v.string(),
    kind: v.string(),
    serviceIntervalDays: v.optional(v.number()),
    lastServicedAt: v.optional(v.number()),
    notes: v.optional(v.string()),
  },
  returns: assetValidator,
  handler: async (ctx, args) => {
    const ownerId = requireOwner(args.serviceToken);
    const now = Date.now();
    const notes = cleanOptionalText(args.notes, "Asset notes");
    const id = await ctx.db.insert("assets", {
      ownerId,
      name: requireText(args.name, "Asset name"),
      kind: requireText(args.kind, "Asset kind"),
      ...(args.serviceIntervalDays === undefined
        ? {}
        : { serviceIntervalDays: validServiceInterval(args.serviceIntervalDays) }),
      ...(args.lastServicedAt === undefined
        ? {}
        : { lastServicedAt: validTimestamp(args.lastServicedAt) }),
      ...(notes === undefined ? {} : { notes }),
      createdAt: now,
      updatedAt: now,
    });
    const asset = await ctx.db.get("assets", id);
    if (!asset) throw new Error("Asset creation failed.");
    return asset;
  },
});

export const update = mutation({
  args: {
    serviceToken: v.string(),
    id: v.string(),
    name: v.optional(v.string()),
    kind: v.optional(v.string()),
    serviceIntervalDays: v.optional(v.number()),
    clearServiceIntervalDays: v.optional(v.boolean()),
    lastServicedAt: v.optional(v.number()),
    clearLastServicedAt: v.optional(v.boolean()),
    notes: v.optional(v.string()),
    clearNotes: v.optional(v.boolean()),
  },
  returns: v.union(assetValidator, v.null()),
  handler: async (ctx, args) => {
    const ownerId = requireOwner(args.serviceToken);

    const name = cleanOptionalText(args.name, "Asset name");
    const kind = cleanOptionalText(args.kind, "Asset kind");
    const notes = cleanOptionalText(args.notes, "Asset notes");

    const patch: {
      name?: string;
      kind?: string;
      serviceIntervalDays?: number | undefined;
      lastServicedAt?: number | undefined;
      notes?: string | undefined;
      updatedAt: number;
    } = { updatedAt: Date.now() };
    if (name !== undefined) patch.name = name;
    if (kind !== undefined) patch.kind = kind;
    if (args.clearServiceIntervalDays) patch.serviceIntervalDays = undefined;
    else if (args.serviceIntervalDays !== undefined)
      patch.serviceIntervalDays = validServiceInterval(args.serviceIntervalDays);
    if (args.clearLastServicedAt) patch.lastServicedAt = undefined;
    else if (args.lastServicedAt !== undefined)
      patch.lastServicedAt = validTimestamp(args.lastServicedAt);
    if (args.clearNotes) patch.notes = undefined;
    else if (notes !== undefined) patch.notes = notes;

    const changedKeys = Object.keys(patch).filter((key) => key !== "updatedAt");
    if (changedKeys.length === 0) {
      throw new Error("Asset update requires at least one changed field.");
    }

    const id = ctx.db.normalizeId("assets", args.id);
    if (!id) return null;
    const asset = await ctx.db.get("assets", id);
    if (!asset || asset.ownerId !== ownerId) return null;
    await ctx.db.patch("assets", id, patch);
    return ctx.db.get("assets", id);
  },
});

export const remove = mutation({
  args: { serviceToken: v.string(), id: v.string() },
  returns: v.union(assetValidator, v.null()),
  handler: async (ctx, args) => {
    const ownerId = requireOwner(args.serviceToken);
    const id = ctx.db.normalizeId("assets", args.id);
    if (!id) return null;
    const asset = await ctx.db.get("assets", id);
    if (!asset || asset.ownerId !== ownerId) return null;
    await ctx.db.delete("assets", id);
    return asset;
  },
});
