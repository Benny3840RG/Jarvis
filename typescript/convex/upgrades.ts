import { v } from "convex/values";

import { collectBounded, requireOwner } from "./authHelpers.js";
import { requireOwnedBuildId } from "./buildOwnership.js";
import { mutation, query } from "./_generated/server.js";

const upgradeValidator = v.object({
  _id: v.id("upgrades"),
  _creationTime: v.number(),
  ownerId: v.string(),
  buildId: v.string(),
  title: v.string(),
  reason: v.optional(v.string()),
  beforeState: v.optional(v.string()),
  afterState: v.optional(v.string()),
  outcome: v.optional(v.string()),
  parts: v.optional(v.array(v.string())),
  version: v.optional(v.string()),
  occurredAt: v.optional(v.number()),
  createdAt: v.number(),
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

/** Trims each part and drops empties; returns undefined when nothing survives. */
function normalizeParts(parts: string[] | undefined): string[] | undefined {
  if (parts === undefined) return undefined;
  const cleaned = parts.map((part) => part.trim()).filter((part) => part.length > 0);
  return cleaned.length > 0 ? cleaned : undefined;
}

export const list = query({
  args: { serviceToken: v.string() },
  returns: v.array(upgradeValidator),
  handler: async (ctx, args) => {
    const ownerId = requireOwner(args.serviceToken);
    return collectBounded(
      ctx.db.query("upgrades").withIndex("by_owner", (q) => q.eq("ownerId", ownerId)),
      "Upgrade",
    );
  },
});

export const get = query({
  args: { serviceToken: v.string(), id: v.string() },
  returns: v.union(upgradeValidator, v.null()),
  handler: async (ctx, args) => {
    const ownerId = requireOwner(args.serviceToken);
    const id = ctx.db.normalizeId("upgrades", args.id);
    if (!id) return null;
    const upgrade = await ctx.db.get("upgrades", id);
    return upgrade && upgrade.ownerId === ownerId ? upgrade : null;
  },
});

export const create = mutation({
  args: {
    serviceToken: v.string(),
    buildId: v.string(),
    title: v.string(),
    reason: v.optional(v.string()),
    beforeState: v.optional(v.string()),
    afterState: v.optional(v.string()),
    outcome: v.optional(v.string()),
    parts: v.optional(v.array(v.string())),
    version: v.optional(v.string()),
    occurredAt: v.optional(v.number()),
  },
  returns: upgradeValidator,
  handler: async (ctx, args) => {
    const ownerId = requireOwner(args.serviceToken);
    const buildId = await requireOwnedBuildId(ctx, ownerId, args.buildId);
    const reason = cleanOptionalText(args.reason, "Upgrade reason");
    const beforeState = cleanOptionalText(args.beforeState, "Upgrade beforeState");
    const afterState = cleanOptionalText(args.afterState, "Upgrade afterState");
    const outcome = cleanOptionalText(args.outcome, "Upgrade outcome");
    const version = cleanOptionalText(args.version, "Upgrade version");
    const parts = normalizeParts(args.parts);
    const id = await ctx.db.insert("upgrades", {
      ownerId,
      buildId,
      title: requireText(args.title, "Upgrade title"),
      ...(reason === undefined ? {} : { reason }),
      ...(beforeState === undefined ? {} : { beforeState }),
      ...(afterState === undefined ? {} : { afterState }),
      ...(outcome === undefined ? {} : { outcome }),
      ...(parts === undefined ? {} : { parts }),
      ...(version === undefined ? {} : { version }),
      ...(args.occurredAt === undefined ? {} : { occurredAt: args.occurredAt }),
      createdAt: Date.now(),
    });
    const upgrade = await ctx.db.get("upgrades", id);
    if (!upgrade) throw new Error("Upgrade creation failed.");
    return upgrade;
  },
});

export const update = mutation({
  args: {
    serviceToken: v.string(),
    id: v.string(),
    buildId: v.optional(v.string()),
    title: v.optional(v.string()),
    reason: v.optional(v.string()),
    clearReason: v.optional(v.boolean()),
    beforeState: v.optional(v.string()),
    clearBeforeState: v.optional(v.boolean()),
    afterState: v.optional(v.string()),
    clearAfterState: v.optional(v.boolean()),
    outcome: v.optional(v.string()),
    clearOutcome: v.optional(v.boolean()),
    parts: v.optional(v.array(v.string())),
    clearParts: v.optional(v.boolean()),
    version: v.optional(v.string()),
    clearVersion: v.optional(v.boolean()),
    occurredAt: v.optional(v.number()),
    clearOccurredAt: v.optional(v.boolean()),
  },
  returns: v.union(upgradeValidator, v.null()),
  handler: async (ctx, args) => {
    const ownerId = requireOwner(args.serviceToken);
    const title = cleanOptionalText(args.title, "Upgrade title");
    const reason = cleanOptionalText(args.reason, "Upgrade reason");
    const beforeState = cleanOptionalText(args.beforeState, "Upgrade beforeState");
    const afterState = cleanOptionalText(args.afterState, "Upgrade afterState");
    const outcome = cleanOptionalText(args.outcome, "Upgrade outcome");
    const version = cleanOptionalText(args.version, "Upgrade version");
    const parts = normalizeParts(args.parts);

    const id = ctx.db.normalizeId("upgrades", args.id);
    if (!id) return null;
    const upgrade = await ctx.db.get("upgrades", id);
    if (!upgrade || upgrade.ownerId !== ownerId) return null;

    const buildId =
      args.buildId === undefined
        ? undefined
        : await requireOwnedBuildId(ctx, ownerId, args.buildId);
    const patch: {
      buildId?: string;
      title?: string;
      reason?: string | undefined;
      beforeState?: string | undefined;
      afterState?: string | undefined;
      outcome?: string | undefined;
      parts?: string[] | undefined;
      version?: string | undefined;
      occurredAt?: number | undefined;
    } = {};
    if (buildId !== undefined) patch.buildId = buildId;
    if (title !== undefined) patch.title = title;
    if (args.clearReason) patch.reason = undefined;
    else if (reason !== undefined) patch.reason = reason;
    if (args.clearBeforeState) patch.beforeState = undefined;
    else if (beforeState !== undefined) patch.beforeState = beforeState;
    if (args.clearAfterState) patch.afterState = undefined;
    else if (afterState !== undefined) patch.afterState = afterState;
    if (args.clearOutcome) patch.outcome = undefined;
    else if (outcome !== undefined) patch.outcome = outcome;
    if (args.clearVersion) patch.version = undefined;
    else if (version !== undefined) patch.version = version;
    if (args.clearOccurredAt) patch.occurredAt = undefined;
    else if (args.occurredAt !== undefined) patch.occurredAt = args.occurredAt;
    if (args.clearParts) patch.parts = undefined;
    else if (args.parts !== undefined) patch.parts = parts;

    if (Object.keys(patch).length === 0) {
      throw new Error("Upgrade update requires at least one changed field.");
    }

    await ctx.db.patch("upgrades", id, patch);
    return ctx.db.get("upgrades", id);
  },
});

export const remove = mutation({
  args: { serviceToken: v.string(), id: v.string() },
  returns: v.union(upgradeValidator, v.null()),
  handler: async (ctx, args) => {
    const ownerId = requireOwner(args.serviceToken);
    const id = ctx.db.normalizeId("upgrades", args.id);
    if (!id) return null;
    const upgrade = await ctx.db.get("upgrades", id);
    if (!upgrade || upgrade.ownerId !== ownerId) return null;
    await ctx.db.delete("upgrades", id);
    return upgrade;
  },
});
