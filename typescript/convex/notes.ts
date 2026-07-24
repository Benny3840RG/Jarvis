import { v } from "convex/values";

import { requireOwner } from "./authHelpers.js";
import {
  noteDocumentValidator,
  noteDomainValidator,
  noteRetentionValidator,
  noteSensitivityValidator,
} from "./noteValidators.js";
import { cleanRequiredText } from "./toolActionLogic.js";
import { mutation, query } from "./_generated/server.js";

const MAX_LIST_LIMIT = 100;
const MAX_TAGS = 20;
const MAX_TAG_LENGTH = 50;

function cleanTags(tags: string[]): string[] {
  if (tags.length > MAX_TAGS) throw new Error(`A note may have at most ${MAX_TAGS} tags.`);
  const result: string[] = [];
  const seen = new Set<string>();
  for (const value of tags) {
    const tag = cleanRequiredText(value, "Note tag");
    if (tag.length > MAX_TAG_LENGTH) {
      throw new Error(`Note tags may not exceed ${MAX_TAG_LENGTH} characters.`);
    }
    if (seen.has(tag)) continue;
    seen.add(tag);
    result.push(tag);
  }
  return result;
}

function validatedLimit(value: number | undefined): number {
  const limit = value ?? 50;
  if (!Number.isInteger(limit) || limit < 1 || limit > MAX_LIST_LIMIT) {
    throw new Error(`Note list limit must be an integer between 1 and ${MAX_LIST_LIMIT}.`);
  }
  return limit;
}

export const create = mutation({
  args: {
    serviceToken: v.string(),
    projectId: v.string(),
    title: v.string(),
    body: v.string(),
    tags: v.array(v.string()),
    domain: noteDomainValidator,
    sensitivity: noteSensitivityValidator,
    retention: noteRetentionValidator,
    idempotencyKey: v.string(),
    actionFingerprint: v.string(),
    sourceRequestId: v.string(),
    correlationId: v.string(),
    source: v.string(),
  },
  returns: noteDocumentValidator,
  handler: async (ctx, args) => {
    const ownerId = requireOwner(args.serviceToken);
    const projectId = cleanRequiredText(args.projectId, "Project ID");
    const title = cleanRequiredText(args.title, "Note title");
    if (title.length > 200) throw new Error("Note title may not exceed 200 characters.");
    const body = cleanRequiredText(args.body, "Note body");
    const tags = cleanTags(args.tags);
    const idempotencyKey = cleanRequiredText(args.idempotencyKey, "Note idempotency key");
    const actionFingerprint = cleanRequiredText(args.actionFingerprint, "Action fingerprint");
    const sourceRequestId = cleanRequiredText(args.sourceRequestId, "Source request ID");
    const correlationId = cleanRequiredText(args.correlationId, "Correlation ID");
    const source = cleanRequiredText(args.source, "Note source");

    const existing = await ctx.db
      .query("notes")
      .withIndex("by_owner_and_project_and_idempotency_key", (q) =>
        q.eq("ownerId", ownerId).eq("projectId", projectId).eq("idempotencyKey", idempotencyKey),
      )
      .unique();
    if (existing) {
      if (existing.actionFingerprint !== actionFingerprint) {
        throw new Error("Note idempotency key already belongs to a different action fingerprint.");
      }
      return existing;
    }

    const now = Date.now();
    const id = await ctx.db.insert("notes", {
      ownerId,
      projectId,
      title,
      body,
      tags,
      domain: args.domain,
      sensitivity: args.sensitivity,
      retention: args.retention,
      idempotencyKey,
      actionFingerprint,
      sourceRequestId,
      correlationId,
      source,
      revision: 1,
      createdAt: now,
      updatedAt: now,
    });
    const note = await ctx.db.get("notes", id);
    if (!note) throw new Error("Note creation failed.");
    return note;
  },
});

export const get = query({
  args: { serviceToken: v.string(), projectId: v.string(), id: v.string() },
  returns: v.union(noteDocumentValidator, v.null()),
  handler: async (ctx, args) => {
    const ownerId = requireOwner(args.serviceToken);
    const projectId = cleanRequiredText(args.projectId, "Project ID");
    const id = ctx.db.normalizeId("notes", args.id);
    if (!id) return null;
    const note = await ctx.db.get("notes", id);
    if (!note || note.ownerId !== ownerId || note.projectId !== projectId) return null;
    return note;
  },
});

export const list = query({
  args: {
    serviceToken: v.string(),
    projectId: v.string(),
    limit: v.optional(v.number()),
  },
  returns: v.array(noteDocumentValidator),
  handler: async (ctx, args) => {
    const ownerId = requireOwner(args.serviceToken);
    const projectId = cleanRequiredText(args.projectId, "Project ID");
    return ctx.db
      .query("notes")
      .withIndex("by_owner_and_project_and_updated_at", (q) =>
        q.eq("ownerId", ownerId).eq("projectId", projectId),
      )
      .order("desc")
      .take(validatedLimit(args.limit));
  },
});
