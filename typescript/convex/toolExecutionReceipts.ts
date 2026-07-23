import { v } from "convex/values";

import { requireOwner } from "./authHelpers.js";
import { cleanRequiredText } from "./toolActionLogic.js";
import {
  toolExecutionErrorCodeValidator,
  toolExecutionReceiptDocumentValidator,
  toolExecutionStatusValidator,
} from "./toolExecutionValidators.js";
import { mutation, query } from "./_generated/server.js";

export const get = query({
  args: { serviceToken: v.string(), receiptKey: v.string() },
  returns: v.union(toolExecutionReceiptDocumentValidator, v.null()),
  handler: async (ctx, args) => {
    const ownerId = requireOwner(args.serviceToken);
    const receiptKey = cleanRequiredText(args.receiptKey, "Receipt key");
    return ctx.db
      .query("toolExecutionReceipts")
      .withIndex("by_owner_and_receipt_key", (q) =>
        q.eq("ownerId", ownerId).eq("receiptKey", receiptKey),
      )
      .unique();
  },
});

export const save = mutation({
  args: {
    serviceToken: v.string(),
    receiptKey: v.string(),
    receiptId: v.string(),
    actionId: v.string(),
    idempotencyKey: v.string(),
    tool: v.string(),
    operation: v.string(),
    status: toolExecutionStatusValidator,
    outputDigest: v.optional(v.string()),
    errorCode: v.optional(toolExecutionErrorCodeValidator),
    startedAt: v.number(),
    completedAt: v.number(),
  },
  returns: toolExecutionReceiptDocumentValidator,
  handler: async (ctx, args) => {
    const ownerId = requireOwner(args.serviceToken);
    const receiptKey = cleanRequiredText(args.receiptKey, "Receipt key");
    const receiptId = cleanRequiredText(args.receiptId, "Receipt ID");
    const actionId = cleanRequiredText(args.actionId, "Tool action ID");
    const idempotencyKey = cleanRequiredText(args.idempotencyKey, "Execution idempotency key");
    const tool = cleanRequiredText(args.tool, "Tool name");
    const operation = cleanRequiredText(args.operation, "Tool operation");

    const existing = await ctx.db
      .query("toolExecutionReceipts")
      .withIndex("by_owner_and_receipt_key", (q) =>
        q.eq("ownerId", ownerId).eq("receiptKey", receiptKey),
      )
      .unique();
    if (existing) return existing;

    const id = await ctx.db.insert("toolExecutionReceipts", {
      ownerId,
      receiptKey,
      receiptId,
      actionId,
      idempotencyKey,
      tool,
      operation,
      status: args.status,
      ...(args.outputDigest === undefined ? {} : { outputDigest: args.outputDigest }),
      ...(args.errorCode === undefined ? {} : { errorCode: args.errorCode }),
      startedAt: args.startedAt,
      completedAt: args.completedAt,
      createdAt: Date.now(),
    });
    const created = await ctx.db.get("toolExecutionReceipts", id);
    if (!created) throw new Error("Tool execution receipt creation failed.");
    return created;
  },
});
