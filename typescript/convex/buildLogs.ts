import { paginationOptsValidator, paginationResultValidator } from "convex/server";
import { v } from "convex/values";

import { collectBounded, requireOwner } from "./authHelpers.js";
import { requirePageSize } from "./toolActionLogic.js";
import { requireOwnedBuildId } from "./buildOwnership.js";
import { mutation, query } from "./_generated/server.js";

const kindValidator = v.union(
  v.literal("origin"),
  v.literal("milestone"),
  v.literal("failure"),
  v.literal("anecdote"),
  v.literal("note"),
);

const buildLogValidator = v.object({
  _id: v.id("buildLogs"),
  _creationTime: v.number(),
  ownerId: v.string(),
  buildId: v.string(),
  kind: kindValidator,
  title: v.string(),
  body: v.optional(v.string()),
  occurredAt: v.optional(v.number()),
  createdAt: v.number(),
  updatedAt: v.optional(v.number()),
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
  returns: v.array(buildLogValidator),
  handler: async (ctx, args) => {
    const ownerId = requireOwner(args.serviceToken);
    return collectBounded(
      ctx.db.query("buildLogs").withIndex("by_owner", (q) => q.eq("ownerId", ownerId)),
      "Build log",
    );
  },
});

export const listPage = query({
  args: {
    serviceToken: v.string(),
    paginationOpts: paginationOptsValidator,
  },
  returns: paginationResultValidator(buildLogValidator),
  handler: async (ctx, args) => {
    const ownerId = requireOwner(args.serviceToken);
    requirePageSize(args.paginationOpts.numItems, "Build log");
    return ctx.db
      .query("buildLogs")
      .withIndex("by_owner", (q) => q.eq("ownerId", ownerId))
      .order("desc")
      .paginate(args.paginationOpts);
  },
});

export const get = query({
  args: { serviceToken: v.string(), id: v.string() },
  returns: v.union(buildLogValidator, v.null()),
  handler: async (ctx, args) => {
    const ownerId = requireOwner(args.serviceToken);
    const id = ctx.db.normalizeId("buildLogs", args.id);
    if (!id) return null;
    const entry = await ctx.db.get("buildLogs", id);
    return entry && entry.ownerId === ownerId ? entry : null;
  },
});

export const create = mutation({
  args: {
    serviceToken: v.string(),
    buildId: v.string(),
    kind: v.optional(kindValidator),
    title: v.string(),
    body: v.optional(v.string()),
    occurredAt: v.optional(v.number()),
  },
  returns: buildLogValidator,
  handler: async (ctx, args) => {
    const ownerId = requireOwner(args.serviceToken);
    const buildId = await requireOwnedBuildId(ctx, ownerId, args.buildId);
    const body = cleanOptionalText(args.body, "Build log body");
    const id = await ctx.db.insert("buildLogs", {
      ownerId,
      buildId,
      kind: args.kind ?? "note",
      title: requireText(args.title, "Build log title"),
      ...(body === undefined ? {} : { body }),
      ...(args.occurredAt === undefined ? {} : { occurredAt: args.occurredAt }),
      createdAt: Date.now(),
      updatedAt: Date.now(),
    });
    const entry = await ctx.db.get("buildLogs", id);
    if (!entry) throw new Error("Build log creation failed.");
    return entry;
  },
});

export const update = mutation({
  args: {
    serviceToken: v.string(),
    id: v.string(),
    buildId: v.optional(v.string()),
    kind: v.optional(kindValidator),
    title: v.optional(v.string()),
    body: v.optional(v.string()),
    clearBody: v.optional(v.boolean()),
    occurredAt: v.optional(v.number()),
    clearOccurredAt: v.optional(v.boolean()),
  },
  returns: v.union(buildLogValidator, v.null()),
  handler: async (ctx, args) => {
    const ownerId = requireOwner(args.serviceToken);
    const title = cleanOptionalText(args.title, "Build log title");
    const body = cleanOptionalText(args.body, "Build log body");

    const id = ctx.db.normalizeId("buildLogs", args.id);
    if (!id) return null;
    const entry = await ctx.db.get("buildLogs", id);
    if (!entry || entry.ownerId !== ownerId) return null;

    const buildId =
      args.buildId === undefined
        ? undefined
        : await requireOwnedBuildId(ctx, ownerId, args.buildId);
    const patch: {
      buildId?: string;
      kind?: "origin" | "milestone" | "failure" | "anecdote" | "note";
      title?: string;
      body?: string | undefined;
      occurredAt?: number | undefined;
      updatedAt?: number;
    } = {};
    if (buildId !== undefined) patch.buildId = buildId;
    if (args.kind !== undefined) patch.kind = args.kind;
    if (title !== undefined) patch.title = title;
    if (args.clearBody) patch.body = undefined;
    else if (body !== undefined) patch.body = body;
    if (args.clearOccurredAt) patch.occurredAt = undefined;
    else if (args.occurredAt !== undefined) patch.occurredAt = args.occurredAt;

    if (Object.keys(patch).length === 0) {
      throw new Error("Build log update requires at least one changed field.");
    }
    patch.updatedAt = Date.now();

    await ctx.db.patch("buildLogs", id, patch);
    return ctx.db.get("buildLogs", id);
  },
});

export const remove = mutation({
  args: { serviceToken: v.string(), id: v.string() },
  returns: v.union(buildLogValidator, v.null()),
  handler: async (ctx, args) => {
    const ownerId = requireOwner(args.serviceToken);
    const id = ctx.db.normalizeId("buildLogs", args.id);
    if (!id) return null;
    const entry = await ctx.db.get("buildLogs", id);
    if (!entry || entry.ownerId !== ownerId) return null;
    await ctx.db.delete("buildLogs", id);
    return entry;
  },
});
