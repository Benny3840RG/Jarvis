import { v } from "convex/values";

import { requireOwner } from "./authHelpers.js";
import { projectRecordDocumentValidator, projectRecordValidator } from "./totalityValidators.js";
import { mutation, query } from "./_generated/server.js";

const MAX_LIST_LIMIT = 100;
const DEFAULT_LIST_LIMIT = 50;

const recordKindValidator = v.union(
  v.literal("component"),
  v.literal("fact"),
  v.literal("assumption"),
  v.literal("constraint"),
  v.literal("measurement"),
  v.literal("decision"),
  v.literal("risk"),
  v.literal("task"),
  v.literal("event"),
);

function cleanRequiredText(value: string, field: string): string {
  const cleaned = value.trim();
  if (cleaned.length === 0) throw new Error(`${field} cannot be empty.`);
  return cleaned;
}

function boundedLimit(limit: number | undefined): number {
  const resolved = limit ?? DEFAULT_LIST_LIMIT;
  if (!Number.isInteger(resolved) || resolved < 1 || resolved > MAX_LIST_LIMIT) {
    throw new Error(`Limit must be an integer between 1 and ${MAX_LIST_LIMIT}.`);
  }
  return resolved;
}

export const upsert = mutation({
  args: {
    serviceToken: v.string(),
    projectKey: v.string(),
    record: projectRecordValidator,
  },
  returns: projectRecordDocumentValidator,
  handler: async (ctx, args) => {
    const ownerId = requireOwner(args.serviceToken);
    const projectKey = cleanRequiredText(args.projectKey, "Project key");
    const recordId = cleanRequiredText(args.record.recordId, "Project record ID");

    const project = await ctx.db
      .query("projects")
      .withIndex("by_owner_and_project_key", (q) =>
        q.eq("ownerId", ownerId).eq("projectKey", projectKey),
      )
      .unique();
    if (!project) throw new Error("Cannot store a record for an unknown project.");

    const existing = await ctx.db
      .query("projectRecords")
      .withIndex("by_owner_and_project_key_and_record_id", (q) =>
        q.eq("ownerId", ownerId).eq("projectKey", projectKey).eq("recordId", recordId),
      )
      .unique();

    const values = {
      ownerId,
      projectKey,
      kind: args.record.kind,
      recordId,
      record: { ...args.record, recordId },
      updatedAt: Date.now(),
    };

    if (existing) {
      await ctx.db.patch("projectRecords", existing._id, values);
      const updated = await ctx.db.get("projectRecords", existing._id);
      if (!updated) throw new Error("Project record update failed.");
      return updated;
    }

    const id = await ctx.db.insert("projectRecords", values);
    const created = await ctx.db.get("projectRecords", id);
    if (!created) throw new Error("Project record creation failed.");
    return created;
  },
});

export const listByKind = query({
  args: {
    serviceToken: v.string(),
    projectKey: v.string(),
    kind: recordKindValidator,
    limit: v.optional(v.number()),
  },
  returns: v.array(projectRecordDocumentValidator),
  handler: async (ctx, args) => {
    const ownerId = requireOwner(args.serviceToken);
    return ctx.db
      .query("projectRecords")
      .withIndex("by_owner_and_project_key_and_kind", (q) =>
        q.eq("ownerId", ownerId).eq("projectKey", args.projectKey.trim()).eq("kind", args.kind),
      )
      .order("desc")
      .take(boundedLimit(args.limit));
  },
});

export const remove = mutation({
  args: { serviceToken: v.string(), projectKey: v.string(), recordId: v.string() },
  returns: v.union(projectRecordDocumentValidator, v.null()),
  handler: async (ctx, args) => {
    const ownerId = requireOwner(args.serviceToken);
    const existing = await ctx.db
      .query("projectRecords")
      .withIndex("by_owner_and_project_key_and_record_id", (q) =>
        q
          .eq("ownerId", ownerId)
          .eq("projectKey", args.projectKey.trim())
          .eq("recordId", args.recordId.trim()),
      )
      .unique();
    if (!existing) return null;
    await ctx.db.delete("projectRecords", existing._id);
    return existing;
  },
});
