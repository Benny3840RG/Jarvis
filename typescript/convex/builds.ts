import { v } from "convex/values";

import { collectBounded, requireOwner } from "./authHelpers.js";
import { mutation, query } from "./_generated/server.js";

const statusValidator = v.union(
  v.literal("planning"),
  v.literal("active"),
  v.literal("shelved"),
  v.literal("retired"),
);

const buildValidator = v.object({
  _id: v.id("builds"),
  _creationTime: v.number(),
  ownerId: v.string(),
  name: v.string(),
  kind: v.string(),
  status: statusValidator,
  description: v.optional(v.string()),
  nickname: v.optional(v.string()),
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

export const list = query({
  args: { serviceToken: v.string() },
  returns: v.array(buildValidator),
  handler: async (ctx, args) => {
    const ownerId = requireOwner(args.serviceToken);
    return collectBounded(
      ctx.db.query("builds").withIndex("by_owner", (q) => q.eq("ownerId", ownerId)),
      "Build",
    );
  },
});

export const get = query({
  args: { serviceToken: v.string(), id: v.string() },
  returns: v.union(buildValidator, v.null()),
  handler: async (ctx, args) => {
    const ownerId = requireOwner(args.serviceToken);
    const id = ctx.db.normalizeId("builds", args.id);
    if (!id) return null;
    const build = await ctx.db.get("builds", id);
    return build && build.ownerId === ownerId ? build : null;
  },
});

export const create = mutation({
  args: {
    serviceToken: v.string(),
    name: v.string(),
    kind: v.string(),
    status: v.optional(statusValidator),
    description: v.optional(v.string()),
    nickname: v.optional(v.string()),
    notes: v.optional(v.string()),
  },
  returns: buildValidator,
  handler: async (ctx, args) => {
    const ownerId = requireOwner(args.serviceToken);
    const now = Date.now();
    const description = cleanOptionalText(args.description, "Build description");
    const nickname = cleanOptionalText(args.nickname, "Build nickname");
    const notes = cleanOptionalText(args.notes, "Build notes");
    const id = await ctx.db.insert("builds", {
      ownerId,
      name: requireText(args.name, "Build name"),
      kind: requireText(args.kind, "Build kind"),
      status: args.status ?? "planning",
      ...(description === undefined ? {} : { description }),
      ...(nickname === undefined ? {} : { nickname }),
      ...(notes === undefined ? {} : { notes }),
      createdAt: now,
      updatedAt: now,
    });
    const build = await ctx.db.get("builds", id);
    if (!build) throw new Error("Build creation failed.");
    return build;
  },
});

export const update = mutation({
  args: {
    serviceToken: v.string(),
    id: v.string(),
    name: v.optional(v.string()),
    kind: v.optional(v.string()),
    status: v.optional(statusValidator),
    description: v.optional(v.string()),
    clearDescription: v.optional(v.boolean()),
    nickname: v.optional(v.string()),
    clearNickname: v.optional(v.boolean()),
    notes: v.optional(v.string()),
    clearNotes: v.optional(v.boolean()),
  },
  returns: v.union(buildValidator, v.null()),
  handler: async (ctx, args) => {
    const ownerId = requireOwner(args.serviceToken);

    const name = cleanOptionalText(args.name, "Build name");
    const kind = cleanOptionalText(args.kind, "Build kind");
    const description = cleanOptionalText(args.description, "Build description");
    const nickname = cleanOptionalText(args.nickname, "Build nickname");
    const notes = cleanOptionalText(args.notes, "Build notes");

    const patch: {
      name?: string;
      kind?: string;
      status?: "planning" | "active" | "shelved" | "retired";
      description?: string | undefined;
      nickname?: string | undefined;
      notes?: string | undefined;
      updatedAt: number;
    } = { updatedAt: Date.now() };
    if (name !== undefined) patch.name = name;
    if (kind !== undefined) patch.kind = kind;
    if (args.status !== undefined) patch.status = args.status;
    if (args.clearDescription) patch.description = undefined;
    else if (description !== undefined) patch.description = description;
    if (args.clearNickname) patch.nickname = undefined;
    else if (nickname !== undefined) patch.nickname = nickname;
    if (args.clearNotes) patch.notes = undefined;
    else if (notes !== undefined) patch.notes = notes;

    const changedKeys = Object.keys(patch).filter((key) => key !== "updatedAt");
    if (changedKeys.length === 0) {
      throw new Error("Build update requires at least one changed field.");
    }

    const id = ctx.db.normalizeId("builds", args.id);
    if (!id) return null;
    const build = await ctx.db.get("builds", id);
    if (!build || build.ownerId !== ownerId) return null;
    await ctx.db.patch("builds", id, patch);
    return ctx.db.get("builds", id);
  },
});

export const remove = mutation({
  args: { serviceToken: v.string(), id: v.string() },
  returns: v.union(buildValidator, v.null()),
  handler: async (ctx, args) => {
    const ownerId = requireOwner(args.serviceToken);
    const id = ctx.db.normalizeId("builds", args.id);
    if (!id) return null;
    const build = await ctx.db.get("builds", id);
    if (!build || build.ownerId !== ownerId) return null;

    const [buildLog, upgrade] = await Promise.all([
      ctx.db
        .query("buildLogs")
        .withIndex("by_owner_and_build_id", (q) =>
          q.eq("ownerId", ownerId).eq("buildId", id),
        )
        .first(),
      ctx.db
        .query("upgrades")
        .withIndex("by_owner_and_build_id", (q) =>
          q.eq("ownerId", ownerId).eq("buildId", id),
        )
        .first(),
    ]);
    if (buildLog || upgrade) {
      throw new Error("Build cannot be deleted while build logs or upgrades still reference it.");
    }

    await ctx.db.delete("builds", id);
    return build;
  },
});
