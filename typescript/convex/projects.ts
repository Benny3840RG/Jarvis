import { v } from "convex/values";

import { requireOwner } from "./authHelpers.js";
import {
  projectPreferencesValidator,
  projectStatusValidator,
  projectValidator,
} from "./totalityValidators.js";
import { mutation, query } from "./_generated/server.js";

const MAX_LIST_LIMIT = 100;
const DEFAULT_LIST_LIMIT = 25;

function cleanRequiredText(value: string, field: string): string {
  const cleaned = value.trim();
  if (cleaned.length === 0) throw new Error(`${field} cannot be empty.`);
  return cleaned;
}

function cleanDomains(domains: string[]): string[] {
  const cleaned = [...new Set(domains.map((domain) => cleanRequiredText(domain, "Domain")))];
  if (cleaned.length === 0) throw new Error("At least one project domain is required.");
  return cleaned;
}

function requireIsoDate(value: string, field: string): string {
  if (!Number.isFinite(Date.parse(value))) throw new Error(`${field} must be an ISO date-time string.`);
  return value;
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
    projectName: v.string(),
    projectType: v.string(),
    status: projectStatusValidator,
    createdAt: v.string(),
    updatedAt: v.string(),
    revision: v.number(),
    domains: v.array(v.string()),
    summary: v.string(),
    preferences: projectPreferencesValidator,
  },
  returns: projectValidator,
  handler: async (ctx, args) => {
    const ownerId = requireOwner(args.serviceToken);
    if (!Number.isInteger(args.revision) || args.revision < 1) {
      throw new Error("Project revision must be a positive integer.");
    }

    const projectKey = cleanRequiredText(args.projectKey, "Project key");
    const values = {
      ownerId,
      projectKey,
      projectName: cleanRequiredText(args.projectName, "Project name"),
      projectType: cleanRequiredText(args.projectType, "Project type"),
      status: args.status,
      createdAt: requireIsoDate(args.createdAt, "Project createdAt"),
      updatedAt: requireIsoDate(args.updatedAt, "Project updatedAt"),
      revision: args.revision,
      domains: cleanDomains(args.domains),
      summary: args.summary.trim(),
      preferences: args.preferences,
    };

    const existing = await ctx.db
      .query("projects")
      .withIndex("by_owner_and_project_key", (q) =>
        q.eq("ownerId", ownerId).eq("projectKey", projectKey),
      )
      .unique();

    if (existing) {
      if (args.revision < existing.revision) {
        throw new Error("Project revision cannot move backwards.");
      }
      await ctx.db.patch("projects", existing._id, values);
      const updated = await ctx.db.get("projects", existing._id);
      if (!updated) throw new Error("Project update failed.");
      return updated;
    }

    const id = await ctx.db.insert("projects", values);
    const created = await ctx.db.get("projects", id);
    if (!created) throw new Error("Project creation failed.");
    return created;
  },
});

export const get = query({
  args: { serviceToken: v.string(), projectKey: v.string() },
  returns: v.union(projectValidator, v.null()),
  handler: async (ctx, args) => {
    const ownerId = requireOwner(args.serviceToken);
    return ctx.db
      .query("projects")
      .withIndex("by_owner_and_project_key", (q) =>
        q.eq("ownerId", ownerId).eq("projectKey", args.projectKey.trim()),
      )
      .unique();
  },
});

export const listRecent = query({
  args: { serviceToken: v.string(), limit: v.optional(v.number()) },
  returns: v.array(projectValidator),
  handler: async (ctx, args) => {
    const ownerId = requireOwner(args.serviceToken);
    return ctx.db
      .query("projects")
      .withIndex("by_owner_and_updated_at", (q) => q.eq("ownerId", ownerId))
      .order("desc")
      .take(boundedLimit(args.limit));
  },
});
