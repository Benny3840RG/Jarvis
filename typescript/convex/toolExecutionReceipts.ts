import { v } from "convex/values";

import { requireOwner } from "./authHelpers.js";
import { reconcileOmegaContractFromReceipt } from "./omegaReconciliation.js";
import { cleanRequiredText } from "./toolActionLogic.js";
import {
  assertCanonicalSafetyBinding,
  safetyBindingValidator,
} from "./safetyBindingValidators.js";
import {
  toolExecutionActorValidator,
  toolExecutionErrorCodeValidator,
  toolExecutionReceiptDocumentValidator,
  toolExecutionStatusValidator,
} from "./toolExecutionValidators.js";
import { mutation, query } from "./_generated/server.js";

function cleanOptionalText(value: string | undefined, field: string): string | undefined {
  return value === undefined ? undefined : cleanRequiredText(value, field);
}

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
    requestId: v.string(),
    projectId: v.string(),
    idempotencyKey: v.string(),
    actionFingerprint: v.string(),
    effectFingerprint: v.optional(v.string()),
    tool: v.string(),
    operation: v.string(),
    actor: toolExecutionActorValidator,
    approvalId: v.optional(v.string()),
    policyVersion: v.string(),
    correlationId: v.string(),
    source: v.string(),
    provider: v.optional(v.string()),
    providerRequestId: v.optional(v.string()),
    providerCorrelationId: v.optional(v.string()),
    reconciliationId: v.optional(v.string()),
    status: toolExecutionStatusValidator,
    outputDigest: v.optional(v.string()),
    errorCode: v.optional(toolExecutionErrorCodeValidator),
    providerErrorCode: v.optional(v.string()),
    startedAt: v.number(),
    completedAt: v.number(),
    safetyBinding: v.optional(safetyBindingValidator),
  },
  returns: toolExecutionReceiptDocumentValidator,
  handler: async (ctx, args) => {
    const ownerId = requireOwner(args.serviceToken);
    const receiptKey = cleanRequiredText(args.receiptKey, "Receipt key");
    const receiptId = cleanRequiredText(args.receiptId, "Receipt ID");
    const actionId = cleanRequiredText(args.actionId, "Tool action ID");
    const requestId = cleanRequiredText(args.requestId, "Request ID");
    const projectId = cleanRequiredText(args.projectId, "Project ID");
    const idempotencyKey = cleanRequiredText(args.idempotencyKey, "Execution idempotency key");
    const actionFingerprint = cleanRequiredText(args.actionFingerprint, "Action fingerprint");
    const effectFingerprint = cleanOptionalText(args.effectFingerprint, "Effect fingerprint");
    const tool = cleanRequiredText(args.tool, "Tool name");
    const operation = cleanRequiredText(args.operation, "Tool operation");
    const approvalId = cleanOptionalText(args.approvalId, "Approval ID");
    const policyVersion = cleanRequiredText(args.policyVersion, "Policy version");
    const correlationId = cleanRequiredText(args.correlationId, "Correlation ID");
    const source = cleanRequiredText(args.source, "Execution source");
    const provider = cleanOptionalText(args.provider, "Provider");
    const providerRequestId = cleanOptionalText(args.providerRequestId, "Provider request ID");
    const providerCorrelationId = cleanOptionalText(
      args.providerCorrelationId,
      "Provider correlation ID",
    );
    const reconciliationId = cleanOptionalText(args.reconciliationId, "Reconciliation ID");
    const providerErrorCode = cleanOptionalText(args.providerErrorCode, "Provider error code");
    if (args.safetyBinding !== undefined) assertCanonicalSafetyBinding(args.safetyBinding);

    const existing = await ctx.db
      .query("toolExecutionReceipts")
      .withIndex("by_owner_and_receipt_key", (q) =>
        q.eq("ownerId", ownerId).eq("receiptKey", receiptKey),
      )
      .unique();
    if (existing) {
      if (existing.actionFingerprint !== actionFingerprint) {
        throw new Error("Execution receipt fingerprint conflict.");
      }
      await reconcileOmegaContractFromReceipt(ctx, ownerId, existing);
      return existing;
    }

    const id = await ctx.db.insert("toolExecutionReceipts", {
      ownerId,
      receiptKey,
      receiptId,
      actionId,
      requestId,
      projectId,
      idempotencyKey,
      actionFingerprint,
      ...(effectFingerprint === undefined ? {} : { effectFingerprint }),
      tool,
      operation,
      actor: args.actor,
      ...(approvalId === undefined ? {} : { approvalId }),
      policyVersion,
      correlationId,
      source,
      ...(provider === undefined ? {} : { provider }),
      ...(providerRequestId === undefined ? {} : { providerRequestId }),
      ...(providerCorrelationId === undefined ? {} : { providerCorrelationId }),
      ...(reconciliationId === undefined ? {} : { reconciliationId }),
      status: args.status,
      ...(args.outputDigest === undefined ? {} : { outputDigest: args.outputDigest }),
      ...(args.errorCode === undefined ? {} : { errorCode: args.errorCode }),
      ...(providerErrorCode === undefined ? {} : { providerErrorCode }),
      startedAt: args.startedAt,
      completedAt: args.completedAt,
      ...(args.safetyBinding === undefined ? {} : { safetyBinding: args.safetyBinding }),
      createdAt: Date.now(),
    });
    const created = await ctx.db.get("toolExecutionReceipts", id);
    if (!created) throw new Error("Tool execution receipt creation failed.");
    await reconcileOmegaContractFromReceipt(ctx, ownerId, created);
    return created;
  },
});
