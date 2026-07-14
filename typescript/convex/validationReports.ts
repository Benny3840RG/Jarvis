import { v } from "convex/values";

import { requireOwner } from "./authHelpers.js";
import {
  validationCheckValidator,
  validationReportValidator,
} from "./totalityValidators.js";
import { mutation, query } from "./_generated/server.js";

const GLOBAL_SCOPE = "__global__";
const MAX_LIST_LIMIT = 100;
const DEFAULT_LIST_LIMIT = 25;

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

export const record = mutation({
  args: {
    serviceToken: v.string(),
    requestId: v.string(),
    projectKey: v.optional(v.string()),
    passed: v.boolean(),
    checks: v.array(validationCheckValidator),
    warnings: v.array(v.string()),
    blockingFailures: v.array(v.string()),
  },
  returns: validationReportValidator,
  handler: async (ctx, args) => {
    const ownerId = requireOwner(args.serviceToken);
    const requestId = args.requestId.trim();
    if (requestId.length === 0) throw new Error("Request ID cannot be empty.");

    const values = {
      ownerId,
      requestId,
      scopeKey: scopeKey(args.projectKey),
      passed: args.passed,
      checks: args.checks,
      warnings: args.warnings,
      blockingFailures: args.blockingFailures,
      createdAt: Date.now(),
    };

    const existing = await ctx.db
      .query("validationReports")
      .withIndex("by_owner_and_request_id", (q) =>
        q.eq("ownerId", ownerId).eq("requestId", requestId),
      )
      .unique();

    if (existing) {
      await ctx.db.patch("validationReports", existing._id, values);
      const updated = await ctx.db.get("validationReports", existing._id);
      if (!updated) throw new Error("Validation report update failed.");
      return updated;
    }

    const id = await ctx.db.insert("validationReports", values);
    const created = await ctx.db.get("validationReports", id);
    if (!created) throw new Error("Validation report creation failed.");
    return created;
  },
});

export const getByRequest = query({
  args: { serviceToken: v.string(), requestId: v.string() },
  returns: v.union(validationReportValidator, v.null()),
  handler: async (ctx, args) => {
    const ownerId = requireOwner(args.serviceToken);
    return ctx.db
      .query("validationReports")
      .withIndex("by_owner_and_request_id", (q) =>
        q.eq("ownerId", ownerId).eq("requestId", args.requestId.trim()),
      )
      .unique();
  },
});

export const listRecent = query({
  args: {
    serviceToken: v.string(),
    projectKey: v.optional(v.string()),
    limit: v.optional(v.number()),
  },
  returns: v.array(validationReportValidator),
  handler: async (ctx, args) => {
    const ownerId = requireOwner(args.serviceToken);
    return ctx.db
      .query("validationReports")
      .withIndex("by_owner_and_scope_key", (q) =>
        q.eq("ownerId", ownerId).eq("scopeKey", scopeKey(args.projectKey)),
      )
      .order("desc")
      .take(boundedLimit(args.limit));
  },
});
