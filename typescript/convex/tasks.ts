import { paginationOptsValidator, paginationResultValidator } from "convex/server";
import { v } from "convex/values";

import { taskActionResultValidator } from "./internalActionValidators.js";
import { collectBounded, requireOwner } from "./authHelpers.js";
import { cleanRequiredText } from "./toolActionLogic.js";
import { mutation, query, type MutationCtx } from "./_generated/server.js";

const taskValidator = v.object({
  _id: v.id("tasks"),
  _creationTime: v.number(),
  ownerId: v.string(),
  title: v.string(),
  completed: v.boolean(),
  category: v.string(),
  projectId: v.optional(v.string()),
  directCreateIdempotencyKey: v.optional(v.string()),
  directCreateFingerprint: v.optional(v.string()),
  updatedAt: v.optional(v.number()),
  revision: v.optional(v.number()),
  createdAt: v.number(),
});

function cleanOptionalText(value: string | undefined, field: string): string | undefined {
  if (value === undefined) return undefined;
  return cleanRequiredText(value, field);
}

function directCreateIdentity(
  idempotencyKey: string | undefined,
  requestFingerprint: string | undefined,
): { idempotencyKey?: string; requestFingerprint?: string } {
  if ((idempotencyKey === undefined) !== (requestFingerprint === undefined)) {
    throw new Error(
      "Task create idempotency key and request fingerprint must be supplied together.",
    );
  }
  if (idempotencyKey === undefined || requestFingerprint === undefined) return {};
  return {
    idempotencyKey: cleanRequiredText(idempotencyKey, "Task create idempotency key"),
    requestFingerprint: cleanRequiredText(requestFingerprint, "Task create request fingerprint"),
  };
}

function requireDirectlyMutableTask(task: { projectId?: string }): void {
  if (task.projectId !== undefined) {
    throw new Error("Project-scoped tasks must be changed through controlled task execution.");
  }
}

function controlledTaskResult(
  task: {
    _id: string;
    title: string;
    category: string;
    completed: boolean;
    projectId?: string;
    createdAt: number;
    updatedAt?: number;
    revision?: number;
  },
  completedAt?: number,
) {
  if (!task.projectId || task.updatedAt === undefined || task.revision === undefined) {
    throw new Error("Controlled task metadata is incomplete.");
  }
  return {
    kind: "task" as const,
    id: task._id,
    projectId: task.projectId,
    title: task.title,
    category: task.category,
    completed: task.completed,
    createdAt: task.createdAt,
    updatedAt: task.updatedAt,
    revision: task.revision,
    ...(completedAt === undefined ? {} : { completedAt }),
  };
}

async function findControlledResult(
  ctx: MutationCtx,
  ownerId: string,
  projectId: string,
  actionFamilyId: "AM-004" | "AM-005",
  idempotencyKey: string,
) {
  return ctx.db
    .query("internalActionResults")
    .withIndex("by_owner_project_family_idempotency", (q) =>
      q
        .eq("ownerId", ownerId)
        .eq("projectId", projectId)
        .eq("actionFamilyId", actionFamilyId)
        .eq("idempotencyKey", idempotencyKey),
    )
    .unique();
}

export const create = mutation({
  args: {
    serviceToken: v.string(),
    title: v.string(),
    category: v.string(),
    idempotencyKey: v.optional(v.string()),
    requestFingerprint: v.optional(v.string()),
  },
  returns: taskValidator,
  handler: async (ctx, args) => {
    const ownerId = requireOwner(args.serviceToken);
    const title = cleanRequiredText(args.title, "Task title");
    const category = cleanRequiredText(args.category, "Task category");
    const identity = directCreateIdentity(args.idempotencyKey, args.requestFingerprint);

    if (identity.idempotencyKey !== undefined && identity.requestFingerprint !== undefined) {
      const receipt = await ctx.db
        .query("directCreateReceipts")
        .withIndex("by_owner_type_and_key", (q) =>
          q.eq("ownerId", ownerId).eq("entityType", "task").eq("idempotencyKey", identity.idempotencyKey as string),
        )
        .unique();
      if (receipt) {
        if (receipt.requestFingerprint !== identity.requestFingerprint) {
          throw new Error("Task create idempotency key conflict.");
        }
        const receiptTaskId = ctx.db.normalizeId("tasks", receipt.entityId);
        const receiptTask = receiptTaskId ? await ctx.db.get("tasks", receiptTaskId) : null;
        if (!receiptTask || receiptTask.ownerId !== ownerId) {
          throw new Error("Task from this create request is no longer available.");
        }
        return receiptTask;
      }

      const existing = await ctx.db
        .query("tasks")
        .withIndex("by_owner_and_direct_create_idempotency_key", (q) =>
          q.eq("ownerId", ownerId).eq("directCreateIdempotencyKey", identity.idempotencyKey),
        )
        .unique();
      if (existing) {
        if (existing.directCreateFingerprint !== identity.requestFingerprint) {
          throw new Error("Task create idempotency key conflict.");
        }
        await ctx.db.insert("directCreateReceipts", {
          ownerId,
          entityType: "task",
          entityId: existing._id,
          idempotencyKey: identity.idempotencyKey,
          requestFingerprint: identity.requestFingerprint,
          createdAt: Date.now(),
        });
        return existing;
      }
    }

    const id = await ctx.db.insert("tasks", {
      ownerId,
      title,
      completed: false,
      category,
      ...(identity.idempotencyKey === undefined
        ? {}
        : {
            directCreateIdempotencyKey: identity.idempotencyKey,
            directCreateFingerprint: identity.requestFingerprint as string,
          }),
      createdAt: Date.now(),
    });
    const task = await ctx.db.get("tasks", id);
    if (!task) throw new Error("Task creation failed.");
    if (identity.idempotencyKey !== undefined && identity.requestFingerprint !== undefined) {
      await ctx.db.insert("directCreateReceipts", {
        ownerId,
        entityType: "task",
        entityId: id,
        idempotencyKey: identity.idempotencyKey,
        requestFingerprint: identity.requestFingerprint,
        createdAt: Date.now(),
      });
    }
    return task;
  },
});

export const createControlled = mutation({
  args: {
    serviceToken: v.string(),
    projectId: v.string(),
    title: v.string(),
    category: v.string(),
    idempotencyKey: v.string(),
    actionFingerprint: v.string(),
    sourceRequestId: v.string(),
    correlationId: v.string(),
    source: v.string(),
  },
  returns: taskActionResultValidator,
  handler: async (ctx, args) => {
    const ownerId = requireOwner(args.serviceToken);
    const projectId = cleanRequiredText(args.projectId, "Project ID");
    const title = cleanRequiredText(args.title, "Task title");
    const category = cleanRequiredText(args.category, "Task category");
    const idempotencyKey = cleanRequiredText(args.idempotencyKey, "Task idempotency key");
    const actionFingerprint = cleanRequiredText(args.actionFingerprint, "Action fingerprint");
    const sourceRequestId = cleanRequiredText(args.sourceRequestId, "Source request ID");
    const correlationId = cleanRequiredText(args.correlationId, "Correlation ID");
    const source = cleanRequiredText(args.source, "Task source");

    const existing = await findControlledResult(ctx, ownerId, projectId, "AM-004", idempotencyKey);
    if (existing) {
      if (existing.actionFingerprint !== actionFingerprint) {
        throw new Error("Task create idempotency key belongs to another action fingerprint.");
      }
      if (existing.result.kind !== "task") throw new Error("Task create result kind mismatch.");
      return existing.result;
    }

    const now = Date.now();
    const id = await ctx.db.insert("tasks", {
      ownerId,
      projectId,
      title,
      completed: false,
      category,
      createdAt: now,
      updatedAt: now,
      revision: 1,
    });
    const task = await ctx.db.get("tasks", id);
    if (!task) throw new Error("Controlled task creation failed.");
    const result = controlledTaskResult(task);
    await ctx.db.insert("internalActionResults", {
      ownerId,
      projectId,
      actionFamilyId: "AM-004",
      idempotencyKey,
      actionFingerprint,
      entityType: "task",
      entityId: id,
      result,
      sourceRequestId,
      correlationId,
      source,
      createdAt: now,
    });
    return result;
  },
});

export const list = query({
  args: { serviceToken: v.string() },
  returns: v.array(taskValidator),
  handler: async (ctx, args) => {
    const ownerId = requireOwner(args.serviceToken);
    return collectBounded(
      ctx.db.query("tasks").withIndex("by_owner", (q) => q.eq("ownerId", ownerId)),
      "Task",
    );
  },
});

export const listPage = query({
  args: {
    serviceToken: v.string(),
    paginationOpts: paginationOptsValidator,
  },
  returns: paginationResultValidator(taskValidator),
  handler: async (ctx, args) => {
    const ownerId = requireOwner(args.serviceToken);
    const { numItems } = args.paginationOpts;
    if (!Number.isInteger(numItems) || numItems < 1 || numItems > 100) {
      throw new Error("Task page size must be an integer from 1 to 100.");
    }
    return ctx.db
      .query("tasks")
      .withIndex("by_owner", (q) => q.eq("ownerId", ownerId))
      .order("desc")
      .paginate(args.paginationOpts);
  },
});

export const getControlled = query({
  args: { serviceToken: v.string(), projectId: v.string(), id: v.string() },
  returns: v.union(taskActionResultValidator, v.null()),
  handler: async (ctx, args) => {
    const ownerId = requireOwner(args.serviceToken);
    const projectId = cleanRequiredText(args.projectId, "Project ID");
    const id = ctx.db.normalizeId("tasks", args.id);
    if (!id) return null;
    const task = await ctx.db.get("tasks", id);
    if (!task || task.ownerId !== ownerId || task.projectId !== projectId) return null;
    return controlledTaskResult(task);
  },
});

export const update = mutation({
  args: {
    serviceToken: v.string(),
    id: v.string(),
    title: v.optional(v.string()),
    category: v.optional(v.string()),
  },
  returns: v.union(taskValidator, v.null()),
  handler: async (ctx, args) => {
    const ownerId = requireOwner(args.serviceToken);
    const title = cleanOptionalText(args.title, "Task title");
    const category = cleanOptionalText(args.category, "Task category");
    if (title === undefined && category === undefined) {
      throw new Error("Task update requires a title or category.");
    }

    const id = ctx.db.normalizeId("tasks", args.id);
    if (!id) return null;
    const task = await ctx.db.get("tasks", id);
    if (!task || task.ownerId !== ownerId) return null;
    requireDirectlyMutableTask(task);
    await ctx.db.patch("tasks", id, {
      ...(title === undefined ? {} : { title }),
      ...(category === undefined ? {} : { category }),
    });
    return ctx.db.get("tasks", id);
  },
});

export const complete = mutation({
  args: { serviceToken: v.string(), id: v.string() },
  returns: v.union(taskValidator, v.null()),
  handler: async (ctx, args) => {
    const ownerId = requireOwner(args.serviceToken);
    const id = ctx.db.normalizeId("tasks", args.id);
    if (!id) return null;
    const task = await ctx.db.get("tasks", id);
    if (!task || task.ownerId !== ownerId) return null;
    requireDirectlyMutableTask(task);
    await ctx.db.patch("tasks", id, { completed: true });
    return ctx.db.get("tasks", id);
  },
});

export const completeControlled = mutation({
  args: {
    serviceToken: v.string(),
    projectId: v.string(),
    id: v.string(),
    idempotencyKey: v.string(),
    actionFingerprint: v.string(),
    sourceRequestId: v.string(),
    correlationId: v.string(),
    source: v.string(),
  },
  returns: v.union(taskActionResultValidator, v.null()),
  handler: async (ctx, args) => {
    const ownerId = requireOwner(args.serviceToken);
    const projectId = cleanRequiredText(args.projectId, "Project ID");
    const idempotencyKey = cleanRequiredText(
      args.idempotencyKey,
      "Task completion idempotency key",
    );
    const actionFingerprint = cleanRequiredText(args.actionFingerprint, "Action fingerprint");
    const sourceRequestId = cleanRequiredText(args.sourceRequestId, "Source request ID");
    const correlationId = cleanRequiredText(args.correlationId, "Correlation ID");
    const source = cleanRequiredText(args.source, "Task source");

    const existing = await findControlledResult(ctx, ownerId, projectId, "AM-005", idempotencyKey);
    if (existing) {
      if (existing.actionFingerprint !== actionFingerprint) {
        throw new Error("Task completion idempotency key belongs to another action fingerprint.");
      }
      if (existing.result.kind !== "task") throw new Error("Task completion result kind mismatch.");
      return existing.result;
    }

    const id = ctx.db.normalizeId("tasks", args.id);
    if (!id) return null;
    const task = await ctx.db.get("tasks", id);
    if (!task || task.ownerId !== ownerId || task.projectId !== projectId) return null;
    if (task.completed) {
      throw new Error("Task is already completed without this controlled action receipt.");
    }

    const now = Date.now();
    const revision = (task.revision ?? 1) + 1;
    await ctx.db.patch("tasks", id, { completed: true, updatedAt: now, revision });
    const completed = await ctx.db.get("tasks", id);
    if (!completed) throw new Error("Controlled task completion failed.");
    const result = controlledTaskResult(completed, now);
    await ctx.db.insert("internalActionResults", {
      ownerId,
      projectId,
      actionFamilyId: "AM-005",
      idempotencyKey,
      actionFingerprint,
      entityType: "task",
      entityId: id,
      result,
      sourceRequestId,
      correlationId,
      source,
      createdAt: now,
    });
    return result;
  },
});

export const remove = mutation({
  args: { serviceToken: v.string(), id: v.string() },
  returns: v.union(taskValidator, v.null()),
  handler: async (ctx, args) => {
    const ownerId = requireOwner(args.serviceToken);
    const id = ctx.db.normalizeId("tasks", args.id);
    if (!id) return null;
    const task = await ctx.db.get("tasks", id);
    if (!task || task.ownerId !== ownerId) return null;
    requireDirectlyMutableTask(task);
    await ctx.db.delete("tasks", id);
    return task;
  },
});

export const cleanupControlled = mutation({
  args: { serviceToken: v.string(), projectId: v.string(), id: v.string() },
  returns: v.boolean(),
  handler: async (ctx, args) => {
    const ownerId = requireOwner(args.serviceToken);
    const projectId = cleanRequiredText(args.projectId, "Project ID");
    const id = ctx.db.normalizeId("tasks", args.id);
    if (!id) return false;
    const task = await ctx.db.get("tasks", id);
    if (task && task.ownerId === ownerId && task.projectId === projectId) {
      await ctx.db.delete("tasks", id);
    }
    const receipts = await ctx.db
      .query("internalActionResults")
      .withIndex("by_owner_entity", (q) =>
        q.eq("ownerId", ownerId).eq("entityType", "task").eq("entityId", id),
      )
      .collect();
    for (const receipt of receipts) {
      if (receipt.projectId === projectId)
        await ctx.db.delete("internalActionResults", receipt._id);
    }
    return task !== null;
  },
});
