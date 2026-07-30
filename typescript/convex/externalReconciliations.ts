import { v } from "convex/values";

import {
  externalReconciliationClaimValidator,
  externalReconciliationDocumentValidator,
  externalReconciliationEnvelopeValidator,
} from "./externalReconciliationValidators.js";
import { requireOwner } from "./authHelpers.js";
import { cleanRequiredText } from "./toolActionLogic.js";
import {
  toolExecutionReceiptDocumentValidator,
  toolExecutionReceiptInputValidator,
} from "./toolExecutionValidators.js";
import type { Doc } from "./_generated/dataModel.js";
import { mutation, query, type MutationCtx, type QueryCtx } from "./_generated/server.js";

const scopeArgs = {
  projectId: v.string(),
  tool: v.string(),
  operation: v.string(),
  idempotencyKey: v.string(),
  effectFingerprint: v.string(),
};

const OBSERVING_RECOVERY_MS = 60_000;

function cleanScope(args: {
  projectId: string;
  tool: string;
  operation: string;
  idempotencyKey: string;
  effectFingerprint: string;
}) {
  return {
    projectId: cleanRequiredText(args.projectId, "Project ID"),
    tool: cleanRequiredText(args.tool, "Tool name"),
    operation: cleanRequiredText(args.operation, "Tool operation"),
    idempotencyKey: cleanRequiredText(args.idempotencyKey, "Execution idempotency key"),
    effectFingerprint: cleanRequiredText(args.effectFingerprint, "Effect fingerprint"),
  };
}

async function findByScope(
  ctx: QueryCtx | MutationCtx,
  ownerId: string,
  scope: { projectId: string; tool: string; operation: string; idempotencyKey: string },
) {
  return ctx.db
    .query("externalReconciliations")
    .withIndex("by_owner_and_scope", (q) =>
      q
        .eq("ownerId", ownerId)
        .eq("projectId", scope.projectId)
        .eq("tool", scope.tool)
        .eq("operation", scope.operation)
        .eq("idempotencyKey", scope.idempotencyKey),
    )
    .unique();
}

async function findByReconciliationId(
  ctx: QueryCtx | MutationCtx,
  ownerId: string,
  reconciliationId: string,
) {
  return ctx.db
    .query("externalReconciliations")
    .withIndex("by_owner_and_reconciliation_id", (q) =>
      q.eq("ownerId", ownerId).eq("reconciliationId", reconciliationId),
    )
    .unique();
}

async function findReceipt(ctx: QueryCtx | MutationCtx, ownerId: string, receiptKey?: string) {
  if (!receiptKey) return null;
  return ctx.db
    .query("toolExecutionReceipts")
    .withIndex("by_owner_and_receipt_key", (q) =>
      q.eq("ownerId", ownerId).eq("receiptKey", receiptKey),
    )
    .unique();
}

function assertEffect(record: Doc<"externalReconciliations">, effectFingerprint: string): void {
  if (record.effectFingerprint !== effectFingerprint) {
    throw new Error("External execution scope belongs to another effect fingerprint.");
  }
}

function assertProvider(record: Doc<"externalReconciliations">, provider: string): void {
  if (record.provider !== provider) {
    throw new Error("External execution scope belongs to another provider.");
  }
}

function receiptDocument(
  ownerId: string,
  receiptKey: string,
  receipt: {
    receiptId: string;
    actionId: string;
    requestId: string;
    projectId: string;
    idempotencyKey: string;
    actionFingerprint: string;
    effectFingerprint?: string;
    tool: string;
    operation: string;
    actor: "user" | "agent" | "tool";
    approvalId?: string;
    policyVersion: string;
    correlationId: string;
    source: string;
    provider?: string;
    providerRequestId?: string;
    providerCorrelationId?: string;
    reconciliationId?: string;
    status: "dry-run" | "succeeded" | "failed" | "indeterminate" | "blocked";
    outputDigest?: string;
    errorCode?:
      | "not-authorized"
      | "not-allowlisted"
      | "invalid-arguments"
      | "indeterminate"
      | "failed"
      | "fingerprint-mismatch"
      | "provider-failed"
      | "provider-reference-missing"
      | "retry-blocked-pending-reconciliation"
      | "reconciliation-escalated"
      | "reconciliation-unavailable";
    providerErrorCode?: string;
    startedAt: number;
    completedAt: number;
  },
  createdAt: number,
) {
  return {
    ownerId,
    receiptKey,
    receiptId: cleanRequiredText(receipt.receiptId, "Receipt ID"),
    actionId: cleanRequiredText(receipt.actionId, "Tool action ID"),
    requestId: cleanRequiredText(receipt.requestId, "Request ID"),
    projectId: cleanRequiredText(receipt.projectId, "Project ID"),
    idempotencyKey: cleanRequiredText(receipt.idempotencyKey, "Execution idempotency key"),
    actionFingerprint: cleanRequiredText(receipt.actionFingerprint, "Action fingerprint"),
    ...(receipt.effectFingerprint === undefined
      ? {}
      : { effectFingerprint: cleanRequiredText(receipt.effectFingerprint, "Effect fingerprint") }),
    tool: cleanRequiredText(receipt.tool, "Tool name"),
    operation: cleanRequiredText(receipt.operation, "Tool operation"),
    actor: receipt.actor,
    ...(receipt.approvalId === undefined
      ? {}
      : { approvalId: cleanRequiredText(receipt.approvalId, "Approval ID") }),
    policyVersion: cleanRequiredText(receipt.policyVersion, "Policy version"),
    correlationId: cleanRequiredText(receipt.correlationId, "Correlation ID"),
    source: cleanRequiredText(receipt.source, "Execution source"),
    ...(receipt.provider === undefined
      ? {}
      : { provider: cleanRequiredText(receipt.provider, "Provider") }),
    ...(receipt.providerRequestId === undefined
      ? {}
      : { providerRequestId: cleanRequiredText(receipt.providerRequestId, "Provider request ID") }),
    ...(receipt.providerCorrelationId === undefined
      ? {}
      : {
          providerCorrelationId: cleanRequiredText(
            receipt.providerCorrelationId,
            "Provider correlation ID",
          ),
        }),
    ...(receipt.reconciliationId === undefined
      ? {}
      : { reconciliationId: cleanRequiredText(receipt.reconciliationId, "Reconciliation ID") }),
    status: receipt.status,
    ...(receipt.outputDigest === undefined
      ? {}
      : { outputDigest: cleanRequiredText(receipt.outputDigest, "Output digest") }),
    ...(receipt.errorCode === undefined ? {} : { errorCode: receipt.errorCode }),
    ...(receipt.providerErrorCode === undefined
      ? {}
      : { providerErrorCode: cleanRequiredText(receipt.providerErrorCode, "Provider error code") }),
    startedAt: receipt.startedAt,
    completedAt: receipt.completedAt,
    createdAt,
  };
}

async function upsertReceipt(
  ctx: MutationCtx,
  ownerId: string,
  receiptKey: string,
  receipt: Parameters<typeof receiptDocument>[2],
) {
  const existing = await findReceipt(ctx, ownerId, receiptKey);
  if (existing && existing.actionFingerprint !== receipt.actionFingerprint) {
    throw new Error("Execution receipt fingerprint conflict.");
  }
  const document = receiptDocument(ownerId, receiptKey, receipt, existing?.createdAt ?? Date.now());
  if (existing) {
    await ctx.db.replace("toolExecutionReceipts", existing._id, document);
    const replaced = await ctx.db.get("toolExecutionReceipts", existing._id);
    if (!replaced) throw new Error("Execution receipt replacement failed.");
    return replaced;
  }
  const id = await ctx.db.insert("toolExecutionReceipts", document);
  const created = await ctx.db.get("toolExecutionReceipts", id);
  if (!created) throw new Error("Execution receipt creation failed.");
  return created;
}

function assertLease(
  record: Doc<"externalReconciliations">,
  workerId: string,
  leaseToken: string,
  now: number,
): void {
  if (
    record.state !== "claimed" ||
    record.leaseOwner !== workerId ||
    record.leaseToken !== leaseToken ||
    record.leaseExpiresAt === undefined ||
    record.leaseExpiresAt <= now
  ) {
    throw new Error("Reconciliation claim lease is stale or belongs to another worker.");
  }
}

export const getByScope = query({
  args: { serviceToken: v.string(), ...scopeArgs },
  returns: v.union(externalReconciliationEnvelopeValidator, v.null()),
  handler: async (ctx, args) => {
    const ownerId = requireOwner(args.serviceToken);
    const scope = cleanScope(args);
    const reconciliation = await findByScope(ctx, ownerId, scope);
    if (!reconciliation) return null;
    assertEffect(reconciliation, scope.effectFingerprint);
    return {
      reconciliation,
      receipt: await findReceipt(ctx, ownerId, reconciliation.receiptKey),
    };
  },
});

export const registerAttempt = mutation({
  args: {
    serviceToken: v.string(),
    ...scopeArgs,
    reconciliationId: v.string(),
    executionKey: v.string(),
    actionId: v.string(),
    requestId: v.string(),
    actionFingerprint: v.string(),
    provider: v.string(),
    providerRequestId: v.string(),
    providerCorrelationId: v.string(),
  },
  returns: externalReconciliationDocumentValidator,
  handler: async (ctx, args) => {
    const ownerId = requireOwner(args.serviceToken);
    const scope = cleanScope(args);
    const reconciliationId = cleanRequiredText(args.reconciliationId, "Reconciliation ID");
    const executionKey = cleanRequiredText(args.executionKey, "Execution key");
    const actionId = cleanRequiredText(args.actionId, "Tool action ID");
    const requestId = cleanRequiredText(args.requestId, "Request ID");
    const actionFingerprint = cleanRequiredText(args.actionFingerprint, "Action fingerprint");
    const provider = cleanRequiredText(args.provider, "Provider");
    const providerRequestId = cleanRequiredText(args.providerRequestId, "Provider request ID");
    const providerCorrelationId = cleanRequiredText(
      args.providerCorrelationId,
      "Provider correlation ID",
    );

    const existing = await findByScope(ctx, ownerId, scope);
    if (existing) {
      assertEffect(existing, scope.effectFingerprint);
      assertProvider(existing, provider);
      if (
        existing.executionKey !== executionKey ||
        existing.providerRequestId !== providerRequestId ||
        existing.providerCorrelationId !== providerCorrelationId
      ) {
        throw new Error("External execution scope has a conflicting provider attempt reference.");
      }
      return existing;
    }

    const duplicateId = await findByReconciliationId(ctx, ownerId, reconciliationId);
    if (duplicateId)
      throw new Error("Reconciliation ID already belongs to another execution scope.");

    const now = Date.now();
    const id = await ctx.db.insert("externalReconciliations", {
      ownerId,
      reconciliationId,
      executionKey,
      actionId,
      requestId,
      projectId: scope.projectId,
      idempotencyKey: scope.idempotencyKey,
      actionFingerprint,
      effectFingerprint: scope.effectFingerprint,
      tool: scope.tool,
      operation: scope.operation,
      provider,
      providerRequestId,
      providerCorrelationId,
      state: "observing",
      attemptCount: 0,
      nextAttemptAt: now,
      createdAt: now,
      updatedAt: now,
    });
    const created = await ctx.db.get("externalReconciliations", id);
    if (!created) throw new Error("External reconciliation creation failed.");
    return created;
  },
});

export const markIndeterminate = mutation({
  args: {
    serviceToken: v.string(),
    ...scopeArgs,
    reconciliationId: v.string(),
    executionKey: v.string(),
    actionId: v.string(),
    requestId: v.string(),
    actionFingerprint: v.string(),
    expectedProvider: v.string(),
    receiptKey: v.string(),
    receipt: toolExecutionReceiptInputValidator,
    missingReferenceReason: v.optional(v.string()),
  },
  returns: externalReconciliationEnvelopeValidator,
  handler: async (ctx, args) => {
    const ownerId = requireOwner(args.serviceToken);
    const scope = cleanScope(args);
    const reconciliationId = cleanRequiredText(args.reconciliationId, "Reconciliation ID");
    const executionKey = cleanRequiredText(args.executionKey, "Execution key");
    const actionId = cleanRequiredText(args.actionId, "Tool action ID");
    const requestId = cleanRequiredText(args.requestId, "Request ID");
    const actionFingerprint = cleanRequiredText(args.actionFingerprint, "Action fingerprint");
    const expectedProvider = cleanRequiredText(args.expectedProvider, "Expected provider");
    const receiptKey = cleanRequiredText(args.receiptKey, "Receipt key");
    if (args.receipt.status !== "indeterminate") {
      throw new Error("markIndeterminate requires an indeterminate receipt.");
    }

    let reconciliation = await findByScope(ctx, ownerId, scope);
    const now = Date.now();
    if (!reconciliation) {
      const duplicateId = await findByReconciliationId(ctx, ownerId, reconciliationId);
      if (duplicateId)
        throw new Error("Reconciliation ID already belongs to another execution scope.");
      const escalationReason = cleanRequiredText(
        args.missingReferenceReason ?? "provider-reference-missing",
        "Missing provider reference reason",
      );
      const id = await ctx.db.insert("externalReconciliations", {
        ownerId,
        reconciliationId,
        executionKey,
        actionId,
        requestId,
        projectId: scope.projectId,
        idempotencyKey: scope.idempotencyKey,
        actionFingerprint,
        effectFingerprint: scope.effectFingerprint,
        tool: scope.tool,
        operation: scope.operation,
        provider: expectedProvider,
        providerCorrelationId: args.receipt.providerCorrelationId ?? args.receipt.correlationId,
        receiptKey,
        receiptId: args.receipt.receiptId,
        state: "escalated",
        attemptCount: 0,
        nextAttemptAt: now,
        escalationReason,
        createdAt: now,
        updatedAt: now,
        escalatedAt: now,
      });
      reconciliation = await ctx.db.get("externalReconciliations", id);
      if (!reconciliation) throw new Error("Escalated reconciliation creation failed.");
    } else {
      assertEffect(reconciliation, scope.effectFingerprint);
      assertProvider(reconciliation, expectedProvider);
      if (reconciliation.state === "resolved") {
        return {
          reconciliation,
          receipt: await findReceipt(ctx, ownerId, reconciliation.receiptKey),
        };
      }
    }

    const state = reconciliation.providerRequestId ? "pending" : "escalated";
    const boundReceipt = await upsertReceipt(ctx, ownerId, receiptKey, {
      ...args.receipt,
      effectFingerprint: scope.effectFingerprint,
      provider: expectedProvider,
      ...(reconciliation.providerRequestId === undefined
        ? {}
        : { providerRequestId: reconciliation.providerRequestId }),
      providerCorrelationId: reconciliation.providerCorrelationId,
      reconciliationId: reconciliation.reconciliationId,
      status: "indeterminate",
      errorCode: state === "pending" ? "indeterminate" : "provider-reference-missing",
    });

    await ctx.db.patch("externalReconciliations", reconciliation._id, {
      receiptKey,
      receiptId: boundReceipt.receiptId,
      state,
      nextAttemptAt: now,
      updatedAt: now,
      ...(state === "escalated"
        ? {
            escalationReason: args.missingReferenceReason ?? "provider-reference-missing",
            escalatedAt: now,
          }
        : {}),
    });
    const updated = await ctx.db.get("externalReconciliations", reconciliation._id);
    if (!updated) throw new Error("Indeterminate reconciliation update failed.");
    return { reconciliation: updated, receipt: boundReceipt };
  },
});

export const completeAttempt = mutation({
  args: {
    serviceToken: v.string(),
    ...scopeArgs,
    reconciliationId: v.string(),
    executionKey: v.string(),
    actionId: v.string(),
    requestId: v.string(),
    actionFingerprint: v.string(),
    expectedProvider: v.string(),
    receiptKey: v.string(),
    receipt: toolExecutionReceiptInputValidator,
  },
  returns: externalReconciliationEnvelopeValidator,
  handler: async (ctx, args) => {
    const ownerId = requireOwner(args.serviceToken);
    const scope = cleanScope(args);
    const expectedProvider = cleanRequiredText(args.expectedProvider, "Expected provider");
    const receiptKey = cleanRequiredText(args.receiptKey, "Receipt key");
    let reconciliation = await findByScope(ctx, ownerId, scope);
    const now = Date.now();

    if (!reconciliation || !reconciliation.providerRequestId) {
      const indeterminateReceipt = {
        ...args.receipt,
        effectFingerprint: scope.effectFingerprint,
        provider: expectedProvider,
        providerCorrelationId: args.receipt.providerCorrelationId ?? args.receipt.correlationId,
        reconciliationId: args.reconciliationId,
        status: "indeterminate" as const,
        errorCode: "provider-reference-missing" as const,
        outputDigest: undefined,
      };
      if (!reconciliation) {
        const id = await ctx.db.insert("externalReconciliations", {
          ownerId,
          reconciliationId: cleanRequiredText(args.reconciliationId, "Reconciliation ID"),
          executionKey: cleanRequiredText(args.executionKey, "Execution key"),
          actionId: cleanRequiredText(args.actionId, "Tool action ID"),
          requestId: cleanRequiredText(args.requestId, "Request ID"),
          projectId: scope.projectId,
          idempotencyKey: scope.idempotencyKey,
          actionFingerprint: cleanRequiredText(args.actionFingerprint, "Action fingerprint"),
          effectFingerprint: scope.effectFingerprint,
          tool: scope.tool,
          operation: scope.operation,
          provider: expectedProvider,
          providerCorrelationId: indeterminateReceipt.providerCorrelationId,
          receiptKey,
          receiptId: args.receipt.receiptId,
          state: "escalated",
          attemptCount: 0,
          nextAttemptAt: now,
          escalationReason: "provider-reference-missing",
          createdAt: now,
          updatedAt: now,
          escalatedAt: now,
        });
        reconciliation = await ctx.db.get("externalReconciliations", id);
      } else {
        assertEffect(reconciliation, scope.effectFingerprint);
        assertProvider(reconciliation, expectedProvider);
        await ctx.db.patch("externalReconciliations", reconciliation._id, {
          receiptKey,
          receiptId: args.receipt.receiptId,
          state: "escalated",
          escalationReason: "provider-reference-missing",
          updatedAt: now,
          escalatedAt: now,
        });
        reconciliation = await ctx.db.get("externalReconciliations", reconciliation._id);
      }
      if (!reconciliation) throw new Error("Missing-reference escalation failed.");
      const receipt = await upsertReceipt(ctx, ownerId, receiptKey, indeterminateReceipt);
      return { reconciliation, receipt };
    }

    assertEffect(reconciliation, scope.effectFingerprint);
    assertProvider(reconciliation, expectedProvider);
    if (
      !(["succeeded", "failed"] as const).includes(args.receipt.status as "succeeded" | "failed")
    ) {
      throw new Error("completeAttempt requires a terminal receipt.");
    }
    const terminalStatus = args.receipt.status as "succeeded" | "failed";
    const boundReceipt = await upsertReceipt(ctx, ownerId, receiptKey, {
      ...args.receipt,
      effectFingerprint: scope.effectFingerprint,
      provider: expectedProvider,
      providerRequestId: reconciliation.providerRequestId,
      providerCorrelationId: reconciliation.providerCorrelationId,
      reconciliationId: reconciliation.reconciliationId,
    });
    await ctx.db.patch("externalReconciliations", reconciliation._id, {
      receiptKey,
      receiptId: boundReceipt.receiptId,
      state: "resolved",
      terminalStatus,
      ...(boundReceipt.outputDigest === undefined
        ? {}
        : { resolutionDigest: boundReceipt.outputDigest }),
      ...(boundReceipt.providerErrorCode === undefined
        ? {}
        : { resolutionErrorCode: boundReceipt.providerErrorCode }),
      updatedAt: now,
      resolvedAt: now,
    });
    const updated = await ctx.db.get("externalReconciliations", reconciliation._id);
    if (!updated) throw new Error("Terminal reconciliation update failed.");
    return { reconciliation: updated, receipt: boundReceipt };
  },
});

export const claimNext = mutation({
  args: {
    serviceToken: v.string(),
    workerId: v.string(),
    leaseToken: v.string(),
    now: v.number(),
    leaseMs: v.number(),
  },
  returns: v.union(externalReconciliationClaimValidator, v.null()),
  handler: async (ctx, args) => {
    const ownerId = requireOwner(args.serviceToken);
    const workerId = cleanRequiredText(args.workerId, "Worker ID");
    const leaseToken = cleanRequiredText(args.leaseToken, "Lease token");
    if (!Number.isSafeInteger(args.leaseMs) || args.leaseMs < 1 || args.leaseMs > 300_000) {
      throw new Error("Lease duration must be an integer between 1 and 300000 milliseconds.");
    }

    const abandonedObservation = await ctx.db
      .query("externalReconciliations")
      .withIndex("by_owner_and_state_and_next_attempt_at", (q) =>
        q
          .eq("ownerId", ownerId)
          .eq("state", "observing")
          .lte("nextAttemptAt", args.now - OBSERVING_RECOVERY_MS),
      )
      .first();
    if (abandonedObservation) {
      await ctx.db.patch("externalReconciliations", abandonedObservation._id, {
        state: "escalated",
        escalationReason: "abandoned-observing-process-interruption",
        updatedAt: args.now,
        escalatedAt: args.now,
      });
      return null;
    }

    let candidate = await ctx.db
      .query("externalReconciliations")
      .withIndex("by_owner_and_state_and_next_attempt_at", (q) =>
        q.eq("ownerId", ownerId).eq("state", "pending").lte("nextAttemptAt", args.now),
      )
      .first();
    if (!candidate) {
      candidate = await ctx.db
        .query("externalReconciliations")
        .withIndex("by_owner_and_state_and_lease_expires_at", (q) =>
          q.eq("ownerId", ownerId).eq("state", "claimed").lte("leaseExpiresAt", args.now),
        )
        .first();
    }
    if (!candidate) return null;

    if (!candidate.providerRequestId || !candidate.receiptKey) {
      await ctx.db.patch("externalReconciliations", candidate._id, {
        state: "escalated",
        escalationReason: "provider-reference-or-receipt-missing",
        updatedAt: args.now,
        escalatedAt: args.now,
      });
      return null;
    }
    const receipt = await findReceipt(ctx, ownerId, candidate.receiptKey);
    if (!receipt) {
      await ctx.db.patch("externalReconciliations", candidate._id, {
        state: "escalated",
        escalationReason: "authoritative-receipt-missing",
        updatedAt: args.now,
        escalatedAt: args.now,
      });
      return null;
    }

    await ctx.db.patch("externalReconciliations", candidate._id, {
      state: "claimed",
      attemptCount: candidate.attemptCount + 1,
      leaseOwner: workerId,
      leaseToken,
      leaseExpiresAt: args.now + args.leaseMs,
      updatedAt: args.now,
    });
    const claimed = await ctx.db.get("externalReconciliations", candidate._id);
    if (!claimed) throw new Error("Reconciliation claim failed.");
    return { reconciliation: claimed, receipt };
  },
});

export const resolveClaim = mutation({
  args: {
    serviceToken: v.string(),
    reconciliationId: v.string(),
    workerId: v.string(),
    leaseToken: v.string(),
    now: v.number(),
    result: v.union(
      v.object({ status: v.literal("succeeded"), outputDigest: v.optional(v.string()) }),
      v.object({ status: v.literal("failed"), errorCode: v.string() }),
    ),
  },
  returns: toolExecutionReceiptDocumentValidator,
  handler: async (ctx, args) => {
    const ownerId = requireOwner(args.serviceToken);
    const reconciliationId = cleanRequiredText(args.reconciliationId, "Reconciliation ID");
    const workerId = cleanRequiredText(args.workerId, "Worker ID");
    const leaseToken = cleanRequiredText(args.leaseToken, "Lease token");
    const reconciliation = await findByReconciliationId(ctx, ownerId, reconciliationId);
    if (!reconciliation) throw new Error("Reconciliation record was not found.");
    assertLease(reconciliation, workerId, leaseToken, args.now);
    const receipt = await findReceipt(ctx, ownerId, reconciliation.receiptKey);
    if (!receipt) throw new Error("Authoritative reconciliation receipt was not found.");

    const quoteDelivery = await ctx.db
      .query("quoteDeliveryAttempts")
      .withIndex("by_owner_and_reconciliation_id", (q) =>
        q.eq("ownerId", ownerId).eq("reconciliationId", reconciliationId),
      )
      .unique();
    if (quoteDelivery?.status === "reconciled") {
      if (quoteDelivery.reconciledOutcome !== args.result.status) {
        throw new Error(
          "Quote delivery reconciliation outcome conflicts with the provider result.",
        );
      }
    } else if (quoteDelivery && quoteDelivery.status !== "indeterminate") {
      throw new Error(
        `Quote delivery attempt is ${quoteDelivery.status}, expected indeterminate before reconciliation.`,
      );
    }

    const replacement = receiptDocument(
      ownerId,
      receipt.receiptKey,
      {
        receiptId: receipt.receiptId,
        actionId: receipt.actionId,
        requestId: receipt.requestId ?? receipt.actionId,
        projectId: receipt.projectId,
        idempotencyKey: receipt.idempotencyKey,
        actionFingerprint: receipt.actionFingerprint,
        effectFingerprint: reconciliation.effectFingerprint,
        tool: receipt.tool,
        operation: receipt.operation,
        actor: receipt.actor ?? "tool",
        ...(receipt.approvalId === undefined ? {} : { approvalId: receipt.approvalId }),
        policyVersion: receipt.policyVersion ?? "legacy-unversioned",
        correlationId: receipt.correlationId ?? reconciliation.providerCorrelationId,
        source: receipt.source ?? "external-reconciliation-worker",
        provider: reconciliation.provider,
        providerRequestId: reconciliation.providerRequestId,
        providerCorrelationId: reconciliation.providerCorrelationId,
        reconciliationId: reconciliation.reconciliationId,
        status: args.result.status,
        ...(args.result.status === "succeeded" && args.result.outputDigest !== undefined
          ? { outputDigest: cleanRequiredText(args.result.outputDigest, "Output digest") }
          : {}),
        ...(args.result.status === "failed"
          ? {
              errorCode: "provider-failed" as const,
              providerErrorCode: cleanRequiredText(args.result.errorCode, "Provider error code"),
            }
          : {}),
        startedAt: receipt.startedAt,
        completedAt: args.now,
      },
      receipt.createdAt,
    );
    await ctx.db.replace("toolExecutionReceipts", receipt._id, replacement);
    await ctx.db.patch("externalReconciliations", reconciliation._id, {
      state: "resolved",
      terminalStatus: args.result.status,
      ...(args.result.status === "succeeded" && args.result.outputDigest !== undefined
        ? { resolutionDigest: args.result.outputDigest }
        : {}),
      ...(args.result.status === "failed" ? { resolutionErrorCode: args.result.errorCode } : {}),
      updatedAt: args.now,
      resolvedAt: args.now,
    });
    if (quoteDelivery?.status === "indeterminate") {
      await ctx.db.patch("quoteDeliveryAttempts", quoteDelivery._id, {
        status: "reconciled",
        reconciledOutcome: args.result.status,
        ...(args.result.status === "failed"
          ? {
              providerErrorCode: cleanRequiredText(
                args.result.errorCode,
                "Provider reconciliation error code",
              ),
            }
          : {}),
        reconciledAt: args.now,
        updatedAt: args.now,
      });
    }
    const updatedReceipt = await ctx.db.get("toolExecutionReceipts", receipt._id);
    if (!updatedReceipt) throw new Error("Authoritative receipt resolution failed.");
    return updatedReceipt;
  },
});

export const releaseClaim = mutation({
  args: {
    serviceToken: v.string(),
    reconciliationId: v.string(),
    workerId: v.string(),
    leaseToken: v.string(),
    now: v.number(),
    errorCode: v.string(),
    nextAttemptAt: v.number(),
    maxAttempts: v.number(),
  },
  returns: externalReconciliationDocumentValidator,
  handler: async (ctx, args) => {
    const ownerId = requireOwner(args.serviceToken);
    const reconciliationId = cleanRequiredText(args.reconciliationId, "Reconciliation ID");
    const workerId = cleanRequiredText(args.workerId, "Worker ID");
    const leaseToken = cleanRequiredText(args.leaseToken, "Lease token");
    const errorCode = cleanRequiredText(args.errorCode, "Reconciliation error code");
    if (!Number.isSafeInteger(args.maxAttempts) || args.maxAttempts < 1 || args.maxAttempts > 100) {
      throw new Error("Maximum attempts must be an integer between 1 and 100.");
    }
    const reconciliation = await findByReconciliationId(ctx, ownerId, reconciliationId);
    if (!reconciliation) throw new Error("Reconciliation record was not found.");
    assertLease(reconciliation, workerId, leaseToken, args.now);

    if (reconciliation.attemptCount >= args.maxAttempts) {
      await ctx.db.patch("externalReconciliations", reconciliation._id, {
        state: "escalated",
        lastErrorCode: errorCode,
        escalationReason: `unresolved-after-${reconciliation.attemptCount}-attempts`,
        updatedAt: args.now,
        escalatedAt: args.now,
      });
    } else {
      if (args.nextAttemptAt <= args.now) {
        throw new Error("Next reconciliation attempt must be scheduled in the future.");
      }
      await ctx.db.patch("externalReconciliations", reconciliation._id, {
        state: "pending",
        lastErrorCode: errorCode,
        nextAttemptAt: args.nextAttemptAt,
        updatedAt: args.now,
      });
    }
    const updated = await ctx.db.get("externalReconciliations", reconciliation._id);
    if (!updated) throw new Error("Reconciliation release failed.");
    return updated;
  },
});

export const cleanup = mutation({
  args: {
    serviceToken: v.string(),
    reconciliationId: v.string(),
    deployment: v.string(),
  },
  returns: v.boolean(),
  handler: async (ctx, args) => {
    const ownerId = requireOwner(args.serviceToken);
    if (args.deployment !== "dev:outgoing-ram-798") {
      throw new Error(
        "External reconciliation cleanup is restricted to the authorised development deployment.",
      );
    }
    const reconciliationId = cleanRequiredText(args.reconciliationId, "Reconciliation ID");
    const reconciliation = await findByReconciliationId(ctx, ownerId, reconciliationId);
    if (!reconciliation) return false;
    const receipt = await findReceipt(ctx, ownerId, reconciliation.receiptKey);
    if (receipt) await ctx.db.delete("toolExecutionReceipts", receipt._id);
    await ctx.db.delete("externalReconciliations", reconciliation._id);
    return true;
  },
});
