import { v } from "convex/values";

import { requireOwner } from "./authHelpers.js";
import {
  cleanRequiredText,
  normaliseAuditPayload,
  normaliseToolArguments,
  requirePositiveRevision,
  sameToolActionProposal,
  validateToolAuthority,
} from "./toolActionLogic.js";
import {
  toolActionActorValidator,
  toolActionDocumentValidator,
  toolActionStateValidator,
  toolAuthorityValidator,
} from "./toolActionValidators.js";
import { mutation, query, type MutationCtx, type QueryCtx } from "./_generated/server.js";
import type { Doc } from "./_generated/dataModel.js";

const MAX_LIST_LIMIT = 100;
const DEFAULT_LIST_LIMIT = 25;

type ReadCtx = QueryCtx | MutationCtx;

function boundedLimit(limit: number | undefined): number {
  const resolved = limit ?? DEFAULT_LIST_LIMIT;
  if (!Number.isInteger(resolved) || resolved < 1 || resolved > MAX_LIST_LIMIT) {
    throw new Error(`Limit must be an integer between 1 and ${MAX_LIST_LIMIT}.`);
  }
  return resolved;
}

async function requireProject(
  ctx: ReadCtx,
  ownerId: string,
  projectKey: string,
): Promise<Doc<"projects">> {
  const project = await ctx.db
    .query("projects")
    .withIndex("by_owner_and_project_key", (q) =>
      q.eq("ownerId", ownerId).eq("projectKey", projectKey),
    )
    .unique();
  if (!project) throw new Error("Tool action project does not exist.");
  return project;
}

async function requireAction(
  ctx: ReadCtx,
  ownerId: string,
  projectKey: string,
  actionId: string,
): Promise<Doc<"toolActions">> {
  const action = await ctx.db
    .query("toolActions")
    .withIndex("by_owner_and_action_id", (q) => q.eq("ownerId", ownerId).eq("actionId", actionId))
    .unique();
  if (!action || action.projectKey !== projectKey) {
    throw new Error("Tool action does not exist.");
  }
  return action;
}

async function appendAudit(
  ctx: MutationCtx,
  input: {
    ownerId: string;
    requestId: string;
    projectKey: string;
    eventType: string;
    actor: "user" | "agent" | "tool";
    payload: Record<string, unknown>;
    createdAt: number;
  },
): Promise<void> {
  await ctx.db.insert("auditEvents", {
    ownerId: input.ownerId,
    requestId: input.requestId,
    scopeKey: input.projectKey,
    eventType: input.eventType,
    actor: input.actor,
    payload: normaliseAuditPayload(input.payload),
    createdAt: input.createdAt,
  });
}

export const stage = mutation({
  args: {
    serviceToken: v.string(),
    actionId: v.string(),
    requestId: v.string(),
    projectKey: v.string(),
    expectedRevision: v.number(),
    tool: v.string(),
    operation: v.string(),
    arguments: v.record(v.string(), v.any()),
    rationale: v.string(),
    requiredAuthority: toolAuthorityValidator,
    destructive: v.boolean(),
    idempotencyKey: v.string(),
    proposedBy: toolActionActorValidator,
  },
  returns: toolActionDocumentValidator,
  handler: async (ctx, args) => {
    const ownerId = requireOwner(args.serviceToken);
    const actionId = cleanRequiredText(args.actionId, "Tool action ID");
    const requestId = cleanRequiredText(args.requestId, "Request ID");
    const projectKey = cleanRequiredText(args.projectKey, "Project key");
    const expectedRevision = requirePositiveRevision(args.expectedRevision, "Expected revision");
    const tool = cleanRequiredText(args.tool, "Tool name");
    const operation = cleanRequiredText(args.operation, "Tool operation");
    const rationale = cleanRequiredText(args.rationale, "Tool action rationale");
    const idempotencyKey = cleanRequiredText(args.idempotencyKey, "Tool idempotency key");
    const normalisedArguments = normaliseToolArguments(args.arguments);
    validateToolAuthority(args.requiredAuthority, args.destructive);

    const proposal = {
      projectKey,
      baseRevision: expectedRevision,
      tool,
      operation,
      arguments: normalisedArguments,
      rationale,
      requiredAuthority: args.requiredAuthority,
      destructive: args.destructive,
      idempotencyKey,
      proposedBy: args.proposedBy,
    };

    const existing = await ctx.db
      .query("toolActions")
      .withIndex("by_owner_and_action_id", (q) => q.eq("ownerId", ownerId).eq("actionId", actionId))
      .unique();
    if (existing) {
      if (!sameToolActionProposal(existing, proposal)) {
        throw new Error("Tool action ID already exists with different contents.");
      }
      return existing;
    }

    const existingIdempotencyKey = await ctx.db
      .query("toolActions")
      .withIndex("by_owner_and_idempotency_key", (q) =>
        q.eq("ownerId", ownerId).eq("idempotencyKey", idempotencyKey),
      )
      .unique();
    if (existingIdempotencyKey) {
      throw new Error("Tool idempotency key already belongs to another action.");
    }

    const project = await requireProject(ctx, ownerId, projectKey);
    if (project.revision !== expectedRevision) {
      throw new Error(
        `Project revision conflict: expected ${expectedRevision}, current ${project.revision}.`,
      );
    }

    const now = Date.now();
    const id = await ctx.db.insert("toolActions", {
      ownerId,
      actionId,
      requestId,
      ...proposal,
      state: "proposed",
      createdAt: now,
      updatedAt: now,
    });
    await appendAudit(ctx, {
      ownerId,
      requestId,
      projectKey,
      eventType: "tool.action.proposed",
      actor: args.proposedBy,
      payload: {
        actionId,
        tool,
        operation,
        baseRevision: expectedRevision,
        requiredAuthority: args.requiredAuthority,
        destructive: args.destructive,
        idempotencyKey,
      },
      createdAt: now,
    });

    const created = await ctx.db.get("toolActions", id);
    if (!created) throw new Error("Tool action creation failed.");
    return created;
  },
});

export const get = query({
  args: { serviceToken: v.string(), projectKey: v.string(), actionId: v.string() },
  returns: v.union(toolActionDocumentValidator, v.null()),
  handler: async (ctx, args) => {
    const ownerId = requireOwner(args.serviceToken);
    const projectKey = cleanRequiredText(args.projectKey, "Project key");
    const action = await ctx.db
      .query("toolActions")
      .withIndex("by_owner_and_action_id", (q) =>
        q.eq("ownerId", ownerId).eq("actionId", args.actionId.trim()),
      )
      .unique();
    return action?.projectKey === projectKey ? action : null;
  },
});

export const listRecent = query({
  args: {
    serviceToken: v.string(),
    projectKey: v.string(),
    state: v.optional(toolActionStateValidator),
    limit: v.optional(v.number()),
  },
  returns: v.array(toolActionDocumentValidator),
  handler: async (ctx, args) => {
    const ownerId = requireOwner(args.serviceToken);
    const projectKey = cleanRequiredText(args.projectKey, "Project key");
    const limit = boundedLimit(args.limit);
    if (args.state === undefined) {
      return ctx.db
        .query("toolActions")
        .withIndex("by_owner_and_project_key", (q) =>
          q.eq("ownerId", ownerId).eq("projectKey", projectKey),
        )
        .order("desc")
        .take(limit);
    }
    return ctx.db
      .query("toolActions")
      .withIndex("by_owner_and_project_key_and_state", (q) =>
        q.eq("ownerId", ownerId).eq("projectKey", projectKey).eq("state", args.state!),
      )
      .order("desc")
      .take(limit);
  },
});

export const approve = mutation({
  args: {
    serviceToken: v.string(),
    projectKey: v.string(),
    actionId: v.string(),
    expectedRevision: v.number(),
  },
  returns: toolActionDocumentValidator,
  handler: async (ctx, args) => {
    const ownerId = requireOwner(args.serviceToken);
    const projectKey = cleanRequiredText(args.projectKey, "Project key");
    const actionId = cleanRequiredText(args.actionId, "Tool action ID");
    const expectedRevision = requirePositiveRevision(args.expectedRevision, "Expected revision");
    const action = await requireAction(ctx, ownerId, projectKey, actionId);

    if (action.baseRevision !== expectedRevision) {
      throw new Error(
        `Project revision conflict: expected ${expectedRevision}, proposal base ${action.baseRevision}.`,
      );
    }
    if (action.state === "rejected") {
      throw new Error("Rejected tool actions cannot be approved.");
    }

    const project = await requireProject(ctx, ownerId, projectKey);
    if (project.revision !== expectedRevision) {
      throw new Error(
        `Project revision conflict: expected ${expectedRevision}, current ${project.revision}.`,
      );
    }
    if (action.state === "approved") return action;

    const now = Date.now();
    await ctx.db.patch("toolActions", action._id, {
      state: "approved",
      approvedBy: "user",
      approvedAt: now,
      updatedAt: now,
    });
    await appendAudit(ctx, {
      ownerId,
      requestId: action.requestId,
      projectKey,
      eventType: "tool.action.approved",
      actor: "user",
      payload: {
        actionId,
        baseRevision: action.baseRevision,
        requiredAuthority: action.requiredAuthority,
        destructive: action.destructive,
      },
      createdAt: now,
    });

    const approved = await ctx.db.get("toolActions", action._id);
    if (!approved) throw new Error("Tool action approval failed.");
    return approved;
  },
});

export const reject = mutation({
  args: {
    serviceToken: v.string(),
    projectKey: v.string(),
    actionId: v.string(),
    reason: v.string(),
  },
  returns: toolActionDocumentValidator,
  handler: async (ctx, args) => {
    const ownerId = requireOwner(args.serviceToken);
    const projectKey = cleanRequiredText(args.projectKey, "Project key");
    const actionId = cleanRequiredText(args.actionId, "Tool action ID");
    const reason = cleanRequiredText(args.reason, "Tool action rejection reason");
    const action = await requireAction(ctx, ownerId, projectKey, actionId);

    if (action.state === "approved") {
      throw new Error("Approved tool actions cannot be rejected.");
    }
    if (action.state === "rejected") {
      if (action.rejectedReason === reason) return action;
      throw new Error("Rejected tool action already has a different reason.");
    }

    const now = Date.now();
    await ctx.db.patch("toolActions", action._id, {
      state: "rejected",
      rejectedBy: "user",
      rejectedReason: reason,
      rejectedAt: now,
      updatedAt: now,
    });
    await appendAudit(ctx, {
      ownerId,
      requestId: action.requestId,
      projectKey,
      eventType: "tool.action.rejected",
      actor: "user",
      payload: { actionId, reason },
      createdAt: now,
    });

    const rejected = await ctx.db.get("toolActions", action._id);
    if (!rejected) throw new Error("Tool action rejection failed.");
    return rejected;
  },
});
