import { paginationOptsValidator, paginationResultValidator } from "convex/server";
import { v } from "convex/values";

import { collectBounded, requireOwner } from "./authHelpers.js";
import { reminderActionResultValidator } from "./internalActionValidators.js";
import { cleanRequiredText, requirePageSize } from "./toolActionLogic.js";
import { mutation, query, type MutationCtx } from "./_generated/server.js";

const reminderValidator = v.object({
  _id: v.id("reminders"),
  _creationTime: v.number(),
  ownerId: v.string(),
  title: v.string(),
  due: v.optional(v.string()),
  dueRaw: v.optional(v.string()),
  dueAt: v.optional(v.number()),
  dueTimezone: v.optional(v.string()),
  projectId: v.optional(v.string()),
  directCreateIdempotencyKey: v.optional(v.string()),
  directCreateFingerprint: v.optional(v.string()),
  updatedAt: v.optional(v.number()),
  revision: v.optional(v.number()),
  createdAt: v.number(),
});

type DueFields = { dueRaw?: string; dueAt?: number; dueTimezone?: string };

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
      "Reminder create idempotency key and request fingerprint must be supplied together.",
    );
  }
  if (idempotencyKey === undefined || requestFingerprint === undefined) return {};
  return {
    idempotencyKey: cleanRequiredText(idempotencyKey, "Reminder create idempotency key"),
    requestFingerprint: cleanRequiredText(
      requestFingerprint,
      "Reminder create request fingerprint",
    ),
  };
}

function requireDirectlyMutableReminder(reminder: { projectId?: string }): void {
  if (reminder.projectId !== undefined) {
    throw new Error(
      "Project-scoped reminders must be changed through controlled reminder execution.",
    );
  }
}

function validatedDue(args: DueFields): DueFields {
  const dueRaw = cleanOptionalText(args.dueRaw, "Reminder due text");
  const dueTimezone = cleanOptionalText(args.dueTimezone, "Reminder due timezone");
  if ((args.dueAt === undefined) !== (dueTimezone === undefined)) {
    throw new Error("A normalized reminder due value requires both a timestamp and timezone.");
  }
  if (args.dueAt !== undefined && dueRaw === undefined) {
    throw new Error("A normalized reminder due value requires the preserved raw text.");
  }
  if (args.dueAt !== undefined && !Number.isFinite(args.dueAt)) {
    throw new Error("Reminder due timestamp must be finite.");
  }

  return {
    ...(dueRaw === undefined ? {} : { dueRaw }),
    ...(args.dueAt === undefined ? {} : { dueAt: args.dueAt, dueTimezone: dueTimezone as string }),
  };
}

function existingDue(reminder: {
  due?: string;
  dueRaw?: string;
  dueAt?: number;
  dueTimezone?: string;
}): DueFields {
  const dueRaw = reminder.dueRaw ?? reminder.due;
  const hasNormalized = reminder.dueAt !== undefined && reminder.dueTimezone !== undefined;
  return {
    ...(dueRaw === undefined ? {} : { dueRaw }),
    ...(hasNormalized ? { dueAt: reminder.dueAt, dueTimezone: reminder.dueTimezone } : {}),
  };
}

function controlledReminderResult(
  reminder: {
    _id: string;
    title: string;
    due?: string;
    dueRaw?: string;
    dueAt?: number;
    dueTimezone?: string;
    projectId?: string;
    createdAt: number;
    updatedAt?: number;
    revision?: number;
  },
  overrides?: { updatedAt?: number; revision?: number; cancelledAt?: number },
) {
  if (!reminder.projectId || reminder.updatedAt === undefined || reminder.revision === undefined) {
    throw new Error("Controlled reminder metadata is incomplete.");
  }
  const due = existingDue(reminder);
  return {
    kind: "reminder" as const,
    id: reminder._id,
    projectId: reminder.projectId,
    title: reminder.title,
    ...due,
    createdAt: reminder.createdAt,
    updatedAt: overrides?.updatedAt ?? reminder.updatedAt,
    revision: overrides?.revision ?? reminder.revision,
    ...(overrides?.cancelledAt === undefined ? {} : { cancelledAt: overrides.cancelledAt }),
  };
}

async function findControlledResult(
  ctx: MutationCtx,
  ownerId: string,
  projectId: string,
  actionFamilyId: "AM-006" | "AM-007",
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
    dueRaw: v.optional(v.string()),
    dueAt: v.optional(v.number()),
    dueTimezone: v.optional(v.string()),
    idempotencyKey: v.optional(v.string()),
    requestFingerprint: v.optional(v.string()),
  },
  returns: reminderValidator,
  handler: async (ctx, args) => {
    const ownerId = requireOwner(args.serviceToken);
    const title = cleanRequiredText(args.title, "Reminder title");
    const due = validatedDue(args);
    const identity = directCreateIdentity(args.idempotencyKey, args.requestFingerprint);

    if (identity.idempotencyKey !== undefined && identity.requestFingerprint !== undefined) {
      const receipt = await ctx.db
        .query("directCreateReceipts")
        .withIndex("by_owner_type_and_key", (q) =>
          q
            .eq("ownerId", ownerId)
            .eq("entityType", "reminder")
            .eq("idempotencyKey", identity.idempotencyKey as string),
        )
        .unique();
      if (receipt) {
        if (receipt.requestFingerprint !== identity.requestFingerprint) {
          throw new Error("Reminder create idempotency key conflict.");
        }
        const receiptReminderId = ctx.db.normalizeId("reminders", receipt.entityId);
        const receiptReminder = receiptReminderId
          ? await ctx.db.get("reminders", receiptReminderId)
          : null;
        if (!receiptReminder || receiptReminder.ownerId !== ownerId) {
          throw new Error("Reminder from this create request is no longer available.");
        }
        return receiptReminder;
      }

      const existing = await ctx.db
        .query("reminders")
        .withIndex("by_owner_and_direct_create_idempotency_key", (q) =>
          q.eq("ownerId", ownerId).eq("directCreateIdempotencyKey", identity.idempotencyKey),
        )
        .unique();
      if (existing) {
        if (existing.directCreateFingerprint !== identity.requestFingerprint) {
          throw new Error("Reminder create idempotency key conflict.");
        }
        await ctx.db.insert("directCreateReceipts", {
          ownerId,
          entityType: "reminder",
          entityId: existing._id,
          idempotencyKey: identity.idempotencyKey,
          requestFingerprint: identity.requestFingerprint,
          createdAt: Date.now(),
        });
        return existing;
      }
    }

    const id = await ctx.db.insert("reminders", {
      ownerId,
      title,
      ...due,
      ...(identity.idempotencyKey === undefined
        ? {}
        : {
            directCreateIdempotencyKey: identity.idempotencyKey,
            directCreateFingerprint: identity.requestFingerprint as string,
          }),
      createdAt: Date.now(),
    });
    const reminder = await ctx.db.get("reminders", id);
    if (!reminder) throw new Error("Reminder creation failed.");
    if (identity.idempotencyKey !== undefined && identity.requestFingerprint !== undefined) {
      await ctx.db.insert("directCreateReceipts", {
        ownerId,
        entityType: "reminder",
        entityId: id,
        idempotencyKey: identity.idempotencyKey,
        requestFingerprint: identity.requestFingerprint,
        createdAt: Date.now(),
      });
    }
    return reminder;
  },
});

export const createControlled = mutation({
  args: {
    serviceToken: v.string(),
    projectId: v.string(),
    title: v.string(),
    dueRaw: v.optional(v.string()),
    dueAt: v.optional(v.number()),
    dueTimezone: v.optional(v.string()),
    idempotencyKey: v.string(),
    actionFingerprint: v.string(),
    sourceRequestId: v.string(),
    correlationId: v.string(),
    source: v.string(),
  },
  returns: reminderActionResultValidator,
  handler: async (ctx, args) => {
    const ownerId = requireOwner(args.serviceToken);
    const projectId = cleanRequiredText(args.projectId, "Project ID");
    const title = cleanRequiredText(args.title, "Reminder title");
    const due = validatedDue(args);
    const idempotencyKey = cleanRequiredText(args.idempotencyKey, "Reminder idempotency key");
    const actionFingerprint = cleanRequiredText(args.actionFingerprint, "Action fingerprint");
    const sourceRequestId = cleanRequiredText(args.sourceRequestId, "Source request ID");
    const correlationId = cleanRequiredText(args.correlationId, "Correlation ID");
    const source = cleanRequiredText(args.source, "Reminder source");

    const existing = await findControlledResult(ctx, ownerId, projectId, "AM-006", idempotencyKey);
    if (existing) {
      if (existing.actionFingerprint !== actionFingerprint) {
        throw new Error("Reminder create idempotency key belongs to another action fingerprint.");
      }
      if (existing.result.kind !== "reminder") {
        throw new Error("Reminder create result kind mismatch.");
      }
      return existing.result;
    }

    const now = Date.now();
    const id = await ctx.db.insert("reminders", {
      ownerId,
      projectId,
      title,
      ...due,
      createdAt: now,
      updatedAt: now,
      revision: 1,
    });
    const reminder = await ctx.db.get("reminders", id);
    if (!reminder) throw new Error("Controlled reminder creation failed.");
    const result = controlledReminderResult(reminder);
    await ctx.db.insert("internalActionResults", {
      ownerId,
      projectId,
      actionFamilyId: "AM-006",
      idempotencyKey,
      actionFingerprint,
      entityType: "reminder",
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
  returns: v.array(reminderValidator),
  handler: async (ctx, args) => {
    const ownerId = requireOwner(args.serviceToken);
    return collectBounded(
      ctx.db.query("reminders").withIndex("by_owner", (q) => q.eq("ownerId", ownerId)),
      "Reminder",
    );
  },
});

export const listPage = query({
  args: {
    serviceToken: v.string(),
    paginationOpts: paginationOptsValidator,
  },
  returns: paginationResultValidator(reminderValidator),
  handler: async (ctx, args) => {
    const ownerId = requireOwner(args.serviceToken);
    requirePageSize(args.paginationOpts.numItems, "Reminder");
    return ctx.db
      .query("reminders")
      .withIndex("by_owner", (q) => q.eq("ownerId", ownerId))
      .order("desc")
      .paginate(args.paginationOpts);
  },
});

export const getControlled = query({
  args: { serviceToken: v.string(), projectId: v.string(), id: v.string() },
  returns: v.union(reminderActionResultValidator, v.null()),
  handler: async (ctx, args) => {
    const ownerId = requireOwner(args.serviceToken);
    const projectId = cleanRequiredText(args.projectId, "Project ID");
    const id = ctx.db.normalizeId("reminders", args.id);
    if (!id) return null;
    const reminder = await ctx.db.get("reminders", id);
    if (!reminder || reminder.ownerId !== ownerId || reminder.projectId !== projectId) return null;
    return controlledReminderResult(reminder);
  },
});

export const update = mutation({
  args: {
    serviceToken: v.string(),
    id: v.string(),
    title: v.optional(v.string()),
    dueRaw: v.optional(v.string()),
    dueAt: v.optional(v.number()),
    dueTimezone: v.optional(v.string()),
    clearDue: v.optional(v.boolean()),
  },
  returns: v.union(reminderValidator, v.null()),
  handler: async (ctx, args) => {
    const ownerId = requireOwner(args.serviceToken);
    const title = cleanOptionalText(args.title, "Reminder title");
    const clearDue = args.clearDue === true;
    const dueSupplied =
      args.dueRaw !== undefined || args.dueAt !== undefined || args.dueTimezone !== undefined;
    if (clearDue && dueSupplied) {
      throw new Error("Reminder update cannot set and clear the due value together.");
    }
    if (title === undefined && !clearDue && !dueSupplied) {
      throw new Error("Reminder update requires a title, due value, or clear-due request.");
    }
    const suppliedDue = dueSupplied ? validatedDue(args) : undefined;
    if (dueSupplied && suppliedDue?.dueRaw === undefined) {
      throw new Error("Reminder due update requires preserved raw text.");
    }

    const id = ctx.db.normalizeId("reminders", args.id);
    if (!id) return null;
    const reminder = await ctx.db.get("reminders", id);
    if (!reminder || reminder.ownerId !== ownerId) return null;
    requireDirectlyMutableReminder(reminder);

    const due = clearDue ? {} : (suppliedDue ?? existingDue(reminder));
    await ctx.db.replace("reminders", id, {
      ownerId,
      title: title ?? reminder.title,
      ...due,
      ...(reminder.directCreateIdempotencyKey === undefined
        ? {}
        : { directCreateIdempotencyKey: reminder.directCreateIdempotencyKey }),
      ...(reminder.directCreateFingerprint === undefined
        ? {}
        : { directCreateFingerprint: reminder.directCreateFingerprint }),
      createdAt: reminder.createdAt,
    });
    return ctx.db.get("reminders", id);
  },
});

export const cancelControlled = mutation({
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
  returns: v.union(reminderActionResultValidator, v.null()),
  handler: async (ctx, args) => {
    const ownerId = requireOwner(args.serviceToken);
    const projectId = cleanRequiredText(args.projectId, "Project ID");
    const idempotencyKey = cleanRequiredText(
      args.idempotencyKey,
      "Reminder cancellation idempotency key",
    );
    const actionFingerprint = cleanRequiredText(args.actionFingerprint, "Action fingerprint");
    const sourceRequestId = cleanRequiredText(args.sourceRequestId, "Source request ID");
    const correlationId = cleanRequiredText(args.correlationId, "Correlation ID");
    const source = cleanRequiredText(args.source, "Reminder source");

    const existing = await findControlledResult(ctx, ownerId, projectId, "AM-007", idempotencyKey);
    if (existing) {
      if (existing.actionFingerprint !== actionFingerprint) {
        throw new Error("Reminder cancellation idempotency key belongs to another fingerprint.");
      }
      if (existing.result.kind !== "reminder") {
        throw new Error("Reminder cancellation result kind mismatch.");
      }
      return existing.result;
    }

    const id = ctx.db.normalizeId("reminders", args.id);
    if (!id) return null;
    const reminder = await ctx.db.get("reminders", id);
    if (!reminder || reminder.ownerId !== ownerId || reminder.projectId !== projectId) return null;

    const now = Date.now();
    const result = controlledReminderResult(reminder, {
      updatedAt: now,
      revision: (reminder.revision ?? 1) + 1,
      cancelledAt: now,
    });
    await ctx.db.insert("internalActionResults", {
      ownerId,
      projectId,
      actionFamilyId: "AM-007",
      idempotencyKey,
      actionFingerprint,
      entityType: "reminder",
      entityId: id,
      result,
      sourceRequestId,
      correlationId,
      source,
      createdAt: now,
    });
    await ctx.db.delete("reminders", id);
    return result;
  },
});

export const remove = mutation({
  args: { serviceToken: v.string(), id: v.string() },
  returns: v.union(reminderValidator, v.null()),
  handler: async (ctx, args) => {
    const ownerId = requireOwner(args.serviceToken);
    const id = ctx.db.normalizeId("reminders", args.id);
    if (!id) return null;
    const reminder = await ctx.db.get("reminders", id);
    if (!reminder || reminder.ownerId !== ownerId) return null;
    requireDirectlyMutableReminder(reminder);
    await ctx.db.delete("reminders", id);
    return reminder;
  },
});

export const cleanupControlled = mutation({
  args: { serviceToken: v.string(), projectId: v.string(), id: v.string() },
  returns: v.boolean(),
  handler: async (ctx, args) => {
    const ownerId = requireOwner(args.serviceToken);
    const projectId = cleanRequiredText(args.projectId, "Project ID");
    const id = ctx.db.normalizeId("reminders", args.id);
    if (!id) return false;
    const reminder = await ctx.db.get("reminders", id);
    if (reminder && reminder.ownerId === ownerId && reminder.projectId === projectId) {
      await ctx.db.delete("reminders", id);
    }
    const results = await ctx.db
      .query("internalActionResults")
      .withIndex("by_owner_entity", (q) =>
        q.eq("ownerId", ownerId).eq("entityType", "reminder").eq("entityId", id),
      )
      .collect();
    for (const result of results) {
      if (result.projectId === projectId) {
        await ctx.db.delete("internalActionResults", result._id);
      }
    }
    return reminder !== null || results.length > 0;
  },
});
