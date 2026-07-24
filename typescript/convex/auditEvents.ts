import { v } from "convex/values";

import { requireOwner } from "./authHelpers.js";
import { normaliseAuditPayload } from "./toolActionLogic.js";
import { auditEventValidator } from "./totalityValidators.js";
import { mutation, query } from "./_generated/server.js";

const GLOBAL_SCOPE = "__global__";
const MAX_LIST_LIMIT = 100;
const DEFAULT_LIST_LIMIT = 50;

function boundedLimit(limit: number | undefined): number {
  const resolved = limit ?? DEFAULT_LIST_LIMIT;
  if (!Number.isInteger(resolved) || resolved < 1 || resolved > MAX_LIST_LIMIT) {
    throw new Error(`Limit must be an integer between 1 and ${MAX_LIST_LIMIT}.`);
  }
  return resolved;
}

function scopeKey(projectKey: string | undefined): string {
  const cleaned = projectKey?.trim();
  return cleaned && cleaned.length > 0 ? cleaned : GLOBAL_SCOPE;
}

export const append = mutation({
  args: {
    serviceToken: v.string(),
    requestId: v.optional(v.string()),
    projectKey: v.optional(v.string()),
    eventType: v.string(),
    actor: v.union(v.literal("user"), v.literal("agent"), v.literal("tool")),
    payload: v.record(v.string(), v.any()),
  },
  returns: auditEventValidator,
  handler: async (ctx, args) => {
    const ownerId = requireOwner(args.serviceToken);
    const eventType = args.eventType.trim();
    if (eventType.length === 0) throw new Error("Audit event type cannot be empty.");
    const requestId = args.requestId?.trim();

    const id = await ctx.db.insert("auditEvents", {
      ownerId,
      ...(requestId ? { requestId } : {}),
      scopeKey: scopeKey(args.projectKey),
      eventType,
      actor: args.actor,
      payload: normaliseAuditPayload(args.payload),
      createdAt: Date.now(),
    });
    const created = await ctx.db.get("auditEvents", id);
    if (!created) throw new Error("Audit event creation failed.");
    return created;
  },
});

export const listRecent = query({
  args: {
    serviceToken: v.string(),
    projectKey: v.optional(v.string()),
    limit: v.optional(v.number()),
  },
  returns: v.array(auditEventValidator),
  handler: async (ctx, args) => {
    const ownerId = requireOwner(args.serviceToken);
    return ctx.db
      .query("auditEvents")
      .withIndex("by_owner_and_scope_key", (q) =>
        q.eq("ownerId", ownerId).eq("scopeKey", scopeKey(args.projectKey)),
      )
      .order("desc")
      .take(boundedLimit(args.limit));
  },
});

export const listByRequest = query({
  args: { serviceToken: v.string(), requestId: v.string(), limit: v.optional(v.number()) },
  returns: v.array(auditEventValidator),
  handler: async (ctx, args) => {
    const ownerId = requireOwner(args.serviceToken);
    return ctx.db
      .query("auditEvents")
      .withIndex("by_owner_and_request_id", (q) =>
        q.eq("ownerId", ownerId).eq("requestId", args.requestId.trim()),
      )
      .order("desc")
      .take(boundedLimit(args.limit));
  },
});
