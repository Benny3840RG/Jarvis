import { v } from "convex/values";

import { requireOwner } from "./authHelpers.js";
import { normaliseAuditPayload } from "./toolActionLogic.js";
import {
  orchestrationFailureCodeValidator,
  orchestrationLeaseGrantValidator,
  orchestrationPublicStepDocumentValidator,
  orchestrationReconciliationDocumentValidator,
  orchestrationRecoveryResultValidator,
  orchestrationRunDocumentValidator,
  orchestrationTriggerSourceValidator,
} from "./orchestrationValidators.js";
import type { Doc } from "./_generated/dataModel.js";
import { mutation, query, type MutationCtx, type QueryCtx } from "./_generated/server.js";

const MAX_NODE_COUNT = 100;
const MAX_RECOVERY_EVIDENCE = 20;
const MAX_RETRIES = 5;
const SAFE_RETRY_FAILURE_CODES = new Set(["execution_budget_exceeded"]);
const ORCHESTRATION_TRIGGER_METADATA_KEYS = new Set([
  "taskType",
  "scheduleId",
  "requestId",
  "source",
  "correlationId",
  "triggerId",
]);
const MIN_LEASE_TTL_MS = 1_000;
const MAX_LEASE_TTL_MS = 15 * 60 * 1_000;

const runArgs = {
  serviceToken: v.string(),
  runId: v.string(),
};

function cleanRequired(value: string, label: string, maxLength = 200): string {
  const cleaned = value.trim();
  if (!cleaned) throw new Error(`${label} cannot be empty.`);
  if (cleaned.length > maxLength) throw new Error(`${label} exceeds ${maxLength} characters.`);
  return cleaned;
}

function allowlistedTriggerMetadata(payload: Record<string, unknown>): Record<string, unknown> {
  const normalised = normaliseAuditPayload(payload);
  return Object.fromEntries(
    Object.entries(normalised).filter(
      ([key, value]) =>
        ORCHESTRATION_TRIGGER_METADATA_KEYS.has(key) &&
        (typeof value === "string" || typeof value === "number" || typeof value === "boolean"),
    ),
  );
}

function validRetryCount(value: number): number {
  if (!Number.isInteger(value) || value < 0 || value > MAX_RETRIES) {
    throw new Error(`Orchestration maxRetries must be an integer between 0 and ${MAX_RETRIES}.`);
  }
  return value;
}

function validLeaseTtl(value: number): number {
  if (!Number.isInteger(value) || value < MIN_LEASE_TTL_MS || value > MAX_LEASE_TTL_MS) {
    throw new Error(
      `Orchestration leaseTtlMs must be an integer between ${MIN_LEASE_TTL_MS} and ${MAX_LEASE_TTL_MS}.`,
    );
  }
  return value;
}

function evidence(
  run: {
    recoveryEvidence: Array<{
      kind: "checkpoint" | "restart" | "retry" | "indeterminate";
      detail: string;
      occurredAt: number;
    }>;
  },
  item: {
    kind: "checkpoint" | "restart" | "retry" | "indeterminate";
    detail: string;
    occurredAt: number;
  },
) {
  const next = [...run.recoveryEvidence, item];
  return next.length > MAX_RECOVERY_EVIDENCE
    ? next.slice(next.length - MAX_RECOVERY_EVIDENCE)
    : next;
}

async function findRun(ctx: QueryCtx | MutationCtx, ownerId: string, runId: string) {
  return ctx.db
    .query("orchestrationRuns")
    .withIndex("by_owner_and_run_id", (q) => q.eq("ownerId", ownerId).eq("runId", runId))
    .unique();
}

async function findStep(
  ctx: QueryCtx | MutationCtx,
  ownerId: string,
  runId: string,
  nodeId: string,
) {
  return ctx.db
    .query("orchestrationSteps")
    .withIndex("by_owner_and_run_id_and_node_id", (q) =>
      q.eq("ownerId", ownerId).eq("runId", runId).eq("nodeId", nodeId),
    )
    .unique();
}

function requireRun<T>(run: T | null): T {
  if (run === null) throw new Error("Orchestration run not found.");
  return run;
}

function requireStep<T>(step: T | null): T {
  if (step === null) throw new Error("Orchestration step not found.");
  return step;
}

function publicStep(
  step: Doc<"orchestrationSteps">,
): Omit<Doc<"orchestrationSteps">, "leaseToken"> {
  const { leaseToken: _leaseToken, ...safe } = step;
  return safe;
}

function requireActiveLease(
  step: { leaseOwner?: string; leaseToken?: string; leaseExpiresAt?: number },
  workerId: string,
  leaseToken: string,
  now: number,
): void {
  const owner = cleanRequired(workerId, "Orchestration worker ID");
  const token = cleanRequired(leaseToken, "Orchestration lease token");
  if (step.leaseOwner !== owner || step.leaseToken !== token) {
    throw new Error("Orchestration lease is not owned by this worker.");
  }
  if (step.leaseExpiresAt === undefined || step.leaseExpiresAt <= now) {
    throw new Error("Orchestration step lease has expired; reconciliation is required.");
  }
}

async function findReconciliation(
  ctx: QueryCtx | MutationCtx,
  ownerId: string,
  reconciliationId: string,
) {
  return ctx.db
    .query("orchestrationReconciliations")
    .withIndex("by_owner_and_reconciliation_id", (q) =>
      q.eq("ownerId", ownerId).eq("reconciliationId", reconciliationId),
    )
    .unique();
}

async function findExternalReconciliation(
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

function requireReconciliation<T>(record: T | null): T {
  if (record === null) throw new Error("Orchestration reconciliation record not found.");
  return record;
}

function requireExternalReconciliation<T>(record: T | null): T {
  if (record === null) {
    throw new Error("Provider-authenticated external reconciliation record not found.");
  }
  return record;
}

function assertExternalBinding(
  orchestration: {
    reconciliationId: string;
    operationId: string;
    effectFingerprint: string;
    provider: string;
    providerRequestId?: string;
    providerCorrelationId: string;
  },
  external: {
    reconciliationId: string;
    operation: string;
    effectFingerprint: string;
    provider: string;
    providerRequestId?: string;
    providerCorrelationId: string;
  },
): void {
  if (
    orchestration.reconciliationId !== external.reconciliationId ||
    orchestration.operationId !== external.operation ||
    orchestration.effectFingerprint !== external.effectFingerprint ||
    orchestration.provider !== external.provider ||
    orchestration.providerRequestId !== external.providerRequestId ||
    orchestration.providerCorrelationId !== external.providerCorrelationId
  ) {
    throw new Error("Orchestration reconciliation is not bound to provider effect evidence.");
  }
}

export const beginRun = mutation({
  args: {
    serviceToken: v.string(),
    runId: v.string(),
    triggerId: v.string(),
    triggerSource: orchestrationTriggerSourceValidator,
    triggerKind: v.string(),
    idempotencyKey: v.string(),
    requestFingerprint: v.string(),
    planFingerprint: v.string(),
    triggerPayload: v.record(v.string(), v.any()),
    authority: v.union(v.literal("T0"), v.literal("T1"), v.literal("T2"), v.literal("T3")),
    policyVersion: v.string(),
    policyFingerprint: v.string(),
    nodeIds: v.array(v.string()),
    maxRetries: v.number(),
  },
  returns: v.union(
    v.object({
      status: v.literal("created"),
      run: orchestrationRunDocumentValidator,
    }),
    v.object({
      status: v.literal("replayed"),
      run: orchestrationRunDocumentValidator,
    }),
    v.object({
      status: v.literal("conflict"),
      run: orchestrationRunDocumentValidator,
    }),
  ),
  handler: async (ctx, args) => {
    const ownerId = requireOwner(args.serviceToken);
    const runId = cleanRequired(args.runId, "Orchestration run ID");
    const triggerId = cleanRequired(args.triggerId, "Orchestration trigger ID");
    const triggerKind = cleanRequired(args.triggerKind, "Orchestration trigger kind");
    const idempotencyKey = cleanRequired(args.idempotencyKey, "Orchestration idempotency key");
    const requestFingerprint = cleanRequired(
      args.requestFingerprint,
      "Orchestration request fingerprint",
    );
    const planFingerprint = cleanRequired(args.planFingerprint, "Orchestration plan fingerprint");
    const triggerPayload = allowlistedTriggerMetadata(args.triggerPayload);
    const policyVersion = cleanRequired(args.policyVersion, "Orchestration policy version");
    const policyFingerprint = cleanRequired(
      args.policyFingerprint,
      "Orchestration policy fingerprint",
    );
    const nodeIds = args.nodeIds.map((nodeId) => cleanRequired(nodeId, "Orchestration node ID"));
    if (nodeIds.length === 0 || nodeIds.length > MAX_NODE_COUNT) {
      throw new Error(`Orchestration node count must be between 1 and ${MAX_NODE_COUNT}.`);
    }
    if (new Set(nodeIds).size !== nodeIds.length) {
      throw new Error("Orchestration node IDs must be unique.");
    }
    const maxRetries = validRetryCount(args.maxRetries);
    const now = Date.now();

    const existing = await ctx.db
      .query("orchestrationRuns")
      .withIndex("by_owner_and_trigger_source_and_idempotency_key", (q) =>
        q
          .eq("ownerId", ownerId)
          .eq("triggerSource", args.triggerSource)
          .eq("idempotencyKey", idempotencyKey),
      )
      .unique();
    if (existing) {
      const sameRequest =
        existing.triggerKind === triggerKind &&
        existing.requestFingerprint === requestFingerprint &&
        existing.planFingerprint === planFingerprint &&
        existing.policyVersion === policyVersion &&
        existing.policyFingerprint === policyFingerprint;
      if (sameRequest) return { status: "replayed" as const, run: existing };
      return { status: "conflict" as const, run: existing };
    }

    const sameRunId = await findRun(ctx, ownerId, runId);
    if (sameRunId) throw new Error("Orchestration run ID already exists.");

    const runDocument = {
      ownerId,
      runId,
      triggerId,
      triggerSource: args.triggerSource,
      triggerKind,
      idempotencyKey,
      requestFingerprint,
      planFingerprint,
      triggerPayload,
      authority: args.authority,
      policyVersion,
      policyFingerprint,
      nodeIds,
      completedStepIds: [],
      checkpointSequence: 0,
      state: "queued" as const,
      retryCount: 0,
      maxRetries,
      recoveryState: "none" as const,
      recoveryEvidence: [],
      createdAt: now,
      updatedAt: now,
    };
    const runDocumentId = await ctx.db.insert("orchestrationRuns", runDocument);
    for (const nodeId of nodeIds) {
      await ctx.db.insert("orchestrationSteps", {
        ownerId,
        runId,
        nodeId,
        state: "pending",
        attempt: 0,
        retryable: false,
        updatedAt: now,
      });
    }
    const created = await ctx.db.get("orchestrationRuns", runDocumentId);
    if (!created) throw new Error("Orchestration run creation failed.");
    return { status: "created" as const, run: created };
  },
});

export const getRun = query({
  args: runArgs,
  returns: v.union(orchestrationRunDocumentValidator, v.null()),
  handler: async (ctx, args) => {
    const ownerId = requireOwner(args.serviceToken);
    return findRun(ctx, ownerId, cleanRequired(args.runId, "Orchestration run ID"));
  },
});

export const listSteps = query({
  args: {
    ...runArgs,
  },
  returns: v.array(orchestrationPublicStepDocumentValidator),
  handler: async (ctx, args) => {
    const ownerId = requireOwner(args.serviceToken);
    const runId = cleanRequired(args.runId, "Orchestration run ID");
    const rows = await ctx.db
      .query("orchestrationSteps")
      .withIndex("by_owner_and_run_id_and_node_id", (q) =>
        q.eq("ownerId", ownerId).eq("runId", runId),
      )
      .take(MAX_NODE_COUNT + 1);
    if (rows.length > MAX_NODE_COUNT)
      throw new Error("Orchestration step list exceeded its bound.");
    return rows.map(publicStep);
  },
});

export const markStepRunning = mutation({
  args: {
    ...runArgs,
    nodeId: v.string(),
    operationId: v.string(),
    workerId: v.string(),
    leaseTtlMs: v.number(),
  },
  returns: orchestrationLeaseGrantValidator,
  handler: async (ctx, args) => {
    const ownerId = requireOwner(args.serviceToken);
    const runId = cleanRequired(args.runId, "Orchestration run ID");
    const nodeId = cleanRequired(args.nodeId, "Orchestration node ID");
    const operationId = cleanRequired(args.operationId, "Orchestration operation ID");
    const leaseOwner = cleanRequired(args.workerId, "Orchestration worker ID");
    const now = Date.now();
    const leaseTtlMs = validLeaseTtl(args.leaseTtlMs);
    const leaseToken = crypto.randomUUID();
    const run = requireRun(await findRun(ctx, ownerId, runId));
    const step = requireStep(await findStep(ctx, ownerId, runId, nodeId));

    if (run.state !== "queued" && run.state !== "running") {
      throw new Error(`Cannot start a step for run ${run.state}.`);
    }
    if (step.state !== "pending") {
      throw new Error(`Cannot transition step ${step.state} to running.`);
    }

    await ctx.db.patch("orchestrationSteps", step._id, {
      operationId,
      state: "running",
      attempt: step.attempt + 1,
      updatedAt: now,
      leaseOwner,
      leaseToken,
      leaseExpiresAt: now + leaseTtlMs,
    });
    await ctx.db.patch("orchestrationRuns", run._id, {
      state: "running",
      checkpointNodeId: nodeId,
      checkpointAt: now,
      checkpointSequence: run.checkpointSequence + 1,
      updatedAt: now,
    });
    const updated = await ctx.db.get("orchestrationSteps", step._id);
    if (!updated) throw new Error("Orchestration step update failed.");
    return { step: publicStep(updated), leaseToken };
  },
});

export const recordStepSuccess = mutation({
  args: {
    ...runArgs,
    nodeId: v.string(),
    workerId: v.string(),
    leaseToken: v.string(),
    outputDigest: v.optional(v.string()),
  },
  returns: orchestrationPublicStepDocumentValidator,
  handler: async (ctx, args) => {
    const ownerId = requireOwner(args.serviceToken);
    const runId = cleanRequired(args.runId, "Orchestration run ID");
    const nodeId = cleanRequired(args.nodeId, "Orchestration node ID");
    const now = Date.now();
    const run = requireRun(await findRun(ctx, ownerId, runId));
    const step = requireStep(await findStep(ctx, ownerId, runId, nodeId));
    if (run.state !== "running") throw new Error(`Cannot complete step for run ${run.state}.`);
    if (step.state !== "running") {
      throw new Error(`Cannot transition step ${step.state} to succeeded.`);
    }
    requireActiveLease(step, args.workerId, args.leaseToken, now);
    const outputDigest =
      args.outputDigest === undefined
        ? undefined
        : cleanRequired(args.outputDigest, "Orchestration output digest");

    await ctx.db.patch("orchestrationSteps", step._id, {
      state: "succeeded",
      ...(outputDigest === undefined ? {} : { outputDigest }),
      updatedAt: now,
      completedAt: now,
      leaseOwner: undefined,
      leaseToken: undefined,
      leaseExpiresAt: undefined,
    });
    const completedStepIds = run.completedStepIds.includes(nodeId)
      ? run.completedStepIds
      : [...run.completedStepIds, nodeId];
    await ctx.db.patch("orchestrationRuns", run._id, {
      completedStepIds,
      state: completedStepIds.length === run.nodeIds.length ? "succeeded" : "running",
      recoveryState:
        completedStepIds.length === run.nodeIds.length && run.recoveryState !== "none"
          ? "recovered"
          : run.recoveryState,
      updatedAt: now,
      checkpointNodeId: nodeId,
      checkpointAt: now,
      checkpointSequence: run.checkpointSequence + 1,
    });
    const updated = await ctx.db.get("orchestrationSteps", step._id);
    if (!updated) throw new Error("Orchestration step update failed.");
    return publicStep(updated);
  },
});

export const recordStepFailure = mutation({
  args: {
    ...runArgs,
    nodeId: v.string(),
    workerId: v.string(),
    leaseToken: v.string(),
    failureCode: orchestrationFailureCodeValidator,
  },
  returns: orchestrationPublicStepDocumentValidator,
  handler: async (ctx, args) => {
    const ownerId = requireOwner(args.serviceToken);
    const runId = cleanRequired(args.runId, "Orchestration run ID");
    const nodeId = cleanRequired(args.nodeId, "Orchestration node ID");
    const now = Date.now();
    const run = requireRun(await findRun(ctx, ownerId, runId));
    const step = requireStep(await findStep(ctx, ownerId, runId, nodeId));
    if (run.state !== "running") throw new Error(`Cannot stop step for run ${run.state}.`);
    if (step.state !== "running") {
      throw new Error(`Cannot transition step ${step.state} to failed.`);
    }
    requireActiveLease(step, args.workerId, args.leaseToken, now);

    await ctx.db.patch("orchestrationSteps", step._id, {
      state: "failed",
      failureCode: args.failureCode,
      retryable: SAFE_RETRY_FAILURE_CODES.has(args.failureCode),
      updatedAt: now,
      completedAt: now,
      leaseOwner: undefined,
      leaseToken: undefined,
      leaseExpiresAt: undefined,
    });
    await ctx.db.patch("orchestrationRuns", run._id, {
      state: "failed",
      failureCode: args.failureCode,
      recoveryState: run.retryCount > 0 ? "escalated" : run.recoveryState,
      updatedAt: now,
      checkpointNodeId: nodeId,
      checkpointAt: now,
      checkpointSequence: run.checkpointSequence + 1,
    });
    const updated = await ctx.db.get("orchestrationSteps", step._id);
    if (!updated) throw new Error("Orchestration step update failed.");
    return publicStep(updated);
  },
});

export const registerReconciliation = mutation({
  args: {
    ...runArgs,
    nodeId: v.string(),
    reconciliationId: v.string(),
    effectFingerprint: v.string(),
    provider: v.string(),
    providerRequestId: v.optional(v.string()),
    providerCorrelationId: v.string(),
  },
  returns: orchestrationReconciliationDocumentValidator,
  handler: async (ctx, args) => {
    const ownerId = requireOwner(args.serviceToken);
    const runId = cleanRequired(args.runId, "Orchestration run ID");
    const nodeId = cleanRequired(args.nodeId, "Orchestration node ID");
    const reconciliationId = cleanRequired(
      args.reconciliationId,
      "Orchestration reconciliation ID",
    );
    const effectFingerprint = cleanRequired(
      args.effectFingerprint,
      "Orchestration effect fingerprint",
    );
    const provider = cleanRequired(args.provider, "Orchestration provider");
    const providerRequestId =
      args.providerRequestId === undefined
        ? undefined
        : cleanRequired(args.providerRequestId, "Orchestration provider request ID");
    const providerCorrelationId = cleanRequired(
      args.providerCorrelationId,
      "Orchestration provider correlation ID",
    );
    const now = Date.now();
    requireRun(await findRun(ctx, ownerId, runId));
    const step = requireStep(await findStep(ctx, ownerId, runId, nodeId));
    if (step.state !== "running") throw new Error("Reconciliation requires a running step.");
    const operationId = step.operationId;
    if (operationId === undefined) {
      throw new Error("Reconciliation requires an operation-bound running step.");
    }
    const external = requireExternalReconciliation(
      await findExternalReconciliation(ctx, ownerId, reconciliationId),
    );
    if (
      external.operation !== operationId ||
      external.effectFingerprint !== effectFingerprint ||
      external.provider !== provider ||
      external.providerRequestId !== providerRequestId ||
      external.providerCorrelationId !== providerCorrelationId
    ) {
      throw new Error("Orchestration reconciliation is not bound to provider effect evidence.");
    }

    const existing = await findReconciliation(ctx, ownerId, reconciliationId);
    if (existing) {
      if (
        existing.runId !== runId ||
        existing.nodeId !== nodeId ||
        existing.attempt !== step.attempt ||
        existing.operationId !== operationId ||
        existing.effectFingerprint !== effectFingerprint ||
        existing.provider !== provider ||
        existing.providerRequestId !== providerRequestId ||
        existing.providerCorrelationId !== providerCorrelationId
      ) {
        throw new Error("Orchestration reconciliation fingerprint conflict.");
      }
      return existing;
    }

    const id = await ctx.db.insert("orchestrationReconciliations", {
      ownerId,
      reconciliationId,
      runId,
      nodeId,
      attempt: step.attempt,
      operationId,
      effectFingerprint,
      provider,
      ...(providerRequestId === undefined ? {} : { providerRequestId }),
      providerCorrelationId,
      state: providerRequestId === undefined ? "escalated" : "pending",
      createdAt: now,
      updatedAt: now,
    });
    const created = await ctx.db.get("orchestrationReconciliations", id);
    if (!created) throw new Error("Orchestration reconciliation creation failed.");
    return created;
  },
});

export const recordStepIndeterminate = mutation({
  args: {
    ...runArgs,
    nodeId: v.string(),
    workerId: v.string(),
    leaseToken: v.string(),
    indeterminateReason: v.string(),
    reconciliationId: v.string(),
  },
  returns: orchestrationPublicStepDocumentValidator,
  handler: async (ctx, args) => {
    const ownerId = requireOwner(args.serviceToken);
    const runId = cleanRequired(args.runId, "Orchestration run ID");
    const nodeId = cleanRequired(args.nodeId, "Orchestration node ID");
    const now = Date.now();
    const indeterminateReason = cleanRequired(
      args.indeterminateReason,
      "Orchestration indeterminate reason",
    );
    const reconciliationId = cleanRequired(
      args.reconciliationId,
      "Orchestration reconciliation ID",
    );
    const run = requireRun(await findRun(ctx, ownerId, runId));
    const step = requireStep(await findStep(ctx, ownerId, runId, nodeId));
    if (run.state !== "running") throw new Error(`Cannot stop step for run ${run.state}.`);
    if (step.state !== "running") {
      throw new Error(`Cannot transition step ${step.state} to indeterminate.`);
    }
    requireActiveLease(step, args.workerId, args.leaseToken, now);
    const reconciliation = requireReconciliation(
      await findReconciliation(ctx, ownerId, reconciliationId),
    );
    assertExternalBinding(
      reconciliation,
      requireExternalReconciliation(
        await findExternalReconciliation(ctx, ownerId, reconciliationId),
      ),
    );

    await ctx.db.patch("orchestrationSteps", step._id, {
      state: "indeterminate",
      failureCode: "dependency_failure",
      retryable: false,
      indeterminateReason,
      reconciliationId,
      updatedAt: now,
      completedAt: now,
      leaseOwner: undefined,
      leaseToken: undefined,
      leaseExpiresAt: undefined,
    });
    await ctx.db.patch("orchestrationRuns", run._id, {
      state: "indeterminate",
      failureCode: "dependency_failure",
      recoveryState: "required",
      recoveryEvidence: evidence(run, {
        kind: "indeterminate",
        detail: `Provider outcome for step ${nodeId} is unknown; reconciliation ${reconciliationId} is required.`,
        occurredAt: now,
      }),
      recoveryReference: reconciliationId,
      checkpointSequence: run.checkpointSequence + 1,
      updatedAt: now,
      checkpointNodeId: nodeId,
      checkpointAt: now,
    });
    const updated = await ctx.db.get("orchestrationSteps", step._id);
    if (!updated) throw new Error("Orchestration step update failed.");
    return publicStep(updated);
  },
});

export const recoverExpiredStep = mutation({
  args: {
    ...runArgs,
    nodeId: v.string(),
    recoveryOwner: v.string(),
    reconciliationId: v.string(),
  },
  returns: orchestrationRecoveryResultValidator,
  handler: async (ctx, args) => {
    const ownerId = requireOwner(args.serviceToken);
    const runId = cleanRequired(args.runId, "Orchestration run ID");
    const nodeId = cleanRequired(args.nodeId, "Orchestration node ID");
    const recoveryOwner = cleanRequired(args.recoveryOwner, "Orchestration recovery owner");
    const reconciliationId = cleanRequired(
      args.reconciliationId,
      "Orchestration reconciliation ID",
    );
    const now = Date.now();
    const run = requireRun(await findRun(ctx, ownerId, runId));
    const step = requireStep(await findStep(ctx, ownerId, runId, nodeId));
    const reconciliation = requireReconciliation(
      await findReconciliation(ctx, ownerId, reconciliationId),
    );
    const external = requireExternalReconciliation(
      await findExternalReconciliation(ctx, ownerId, reconciliationId),
    );
    assertExternalBinding(reconciliation, external);
    if (
      reconciliation.runId !== runId ||
      reconciliation.nodeId !== nodeId ||
      reconciliation.attempt !== step.attempt ||
      reconciliation.operationId !== step.operationId
    ) {
      throw new Error("Orchestration reconciliation is not bound to this step attempt.");
    }
    if (terminalState === "succeeded" || terminalState === "failed") {
      throw new Error("A terminal reconciliation cannot recover a running step.");
    }
    if (run.state !== "running") throw new Error(`Cannot recover a step for run ${run.state}.`);
    if (step.state !== "running" || step.leaseExpiresAt === undefined) {
      throw new Error("Orchestration step has no expired running lease.");
    }
    if (step.leaseExpiresAt > now) throw new Error("Orchestration step lease is still active.");

    await ctx.db.patch("orchestrationSteps", step._id, {
      state: "indeterminate",
      failureCode: "dependency_failure",
      retryable: false,
      indeterminateReason: `Lease expired while ${recoveryOwner} owned the step; provider outcome is unknown.`,
      reconciliationId,
      updatedAt: now,
      completedAt: now,
      leaseOwner: undefined,
      leaseToken: undefined,
      leaseExpiresAt: undefined,
    });
    await ctx.db.patch("orchestrationRuns", run._id, {
      state: "indeterminate",
      failureCode: "dependency_failure",
      recoveryState: "required",
      recoveryReference: reconciliationId,
      recoveryEvidence: evidence(run, {
        kind: "restart",
        detail: `Expired step lease detected by ${recoveryOwner}; reconciliation ${reconciliationId} is required.`,
        occurredAt: now,
      }),
      checkpointNodeId: nodeId,
      checkpointAt: now,
      checkpointSequence: run.checkpointSequence + 1,
      updatedAt: now,
    });
    const recoveredRun = await ctx.db.get("orchestrationRuns", run._id);
    const recoveredStep = await ctx.db.get("orchestrationSteps", step._id);
    if (!recoveredRun || !recoveredStep) throw new Error("Orchestration recovery update failed.");
    return {
      status: "indeterminate" as const,
      run: recoveredRun,
      step: publicStep(recoveredStep),
    };
  },
});

export const retryFailedStep = mutation({
  args: {
    ...runArgs,
    nodeId: v.string(),
  },
  returns: orchestrationPublicStepDocumentValidator,
  handler: async (ctx, args) => {
    const ownerId = requireOwner(args.serviceToken);
    const runId = cleanRequired(args.runId, "Orchestration run ID");
    const nodeId = cleanRequired(args.nodeId, "Orchestration node ID");
    const now = Date.now();
    const run = requireRun(await findRun(ctx, ownerId, runId));
    const step = requireStep(await findStep(ctx, ownerId, runId, nodeId));
    if (run.state !== "failed" && run.state !== "running") {
      throw new Error(`Cannot retry a step for run ${run.state}.`);
    }
    if (step.state !== "failed" || !step.retryable) {
      throw new Error("Only retryable failed steps may be retried.");
    }
    if (run.retryCount >= run.maxRetries) {
      throw new Error("Orchestration retry budget exhausted.");
    }

    await ctx.db.patch("orchestrationSteps", step._id, {
      state: "pending",
      failureCode: undefined,
      indeterminateReason: undefined,
      reconciliationId: undefined,
      updatedAt: now,
      nextAttemptAt: now,
      completedAt: undefined,
    });
    await ctx.db.patch("orchestrationRuns", run._id, {
      state: "running",
      retryCount: run.retryCount + 1,
      recoveryState: "retrying",
      recoveryEvidence: evidence(run, {
        kind: "retry",
        detail: `Retry ${run.retryCount + 1} authorised for failed step ${nodeId}.`,
        occurredAt: now,
      }),
      checkpointNodeId: nodeId,
      checkpointAt: now,
      checkpointSequence: run.checkpointSequence + 1,
      updatedAt: now,
    });
    const updated = await ctx.db.get("orchestrationSteps", step._id);
    if (!updated) throw new Error("Orchestration retry update failed.");
    return publicStep(updated);
  },
});

export const resolveIndeterminate = mutation({
  args: {
    ...runArgs,
    nodeId: v.string(),
    reconciliationId: v.string(),
  },
  returns: orchestrationPublicStepDocumentValidator,
  handler: async (ctx, args) => {
    const ownerId = requireOwner(args.serviceToken);
    const runId = cleanRequired(args.runId, "Orchestration run ID");
    const nodeId = cleanRequired(args.nodeId, "Orchestration node ID");
    const reconciliationId = cleanRequired(
      args.reconciliationId,
      "Orchestration reconciliation ID",
    );
    const now = Date.now();
    const run = requireRun(await findRun(ctx, ownerId, runId));
    const step = requireStep(await findStep(ctx, ownerId, runId, nodeId));
    const reconciliation = requireReconciliation(
      await findReconciliation(ctx, ownerId, reconciliationId),
    );
    if (
      reconciliation.runId !== runId ||
      reconciliation.nodeId !== nodeId ||
      reconciliation.attempt !== step.attempt ||
      reconciliation.operationId !== step.operationId
    ) {
      throw new Error("Orchestration reconciliation is not bound to this step attempt.");
    }
    if (run.state !== "indeterminate" || step.state !== "indeterminate") {
      throw new Error("Only an indeterminate orchestration step may be resolved.");
    }
    if (external.state !== "resolved" || external.terminalStatus === undefined) {
      throw new Error("Provider reconciliation has no authenticated terminal outcome.");
    }
    const terminalState = external.terminalStatus;
    const terminalFailureCode = terminalState === "failed" ? "postcondition_failed" as const : undefined;
    await ctx.db.patch("orchestrationReconciliations", reconciliation._id, {
      state: terminalState,
      ...(external.resolutionDigest === undefined
        ? {}
        : { outputDigest: external.resolutionDigest }),
      ...(terminalFailureCode === undefined ? {} : { failureCode: terminalFailureCode }),
      terminalEvidence: {
        kind: "indeterminate",
        detail: `Provider-authenticated reconciliation ${external.reconciliationId} resolved as ${terminalState}.`,
        occurredAt: external.resolvedAt ?? now,
      },
      updatedAt: now,
      resolvedAt: external.resolvedAt ?? now,
    });

    const completedStepIds =
      terminalState === "succeeded" && !run.completedStepIds.includes(nodeId)
        ? [...run.completedStepIds, nodeId]
        : run.completedStepIds;
    const runState =
      terminalState === "succeeded" && completedStepIds.length === run.nodeIds.length
        ? "succeeded"
        : terminalState === "succeeded"
          ? "running"
          : "failed";
    await ctx.db.patch("orchestrationSteps", step._id, {
      state: reconciliation.state,
      ...(external.resolutionDigest === undefined
        ? {}
        : { outputDigest: external.resolutionDigest }),
      ...(terminalState === "failed"
        ? { failureCode: reconciliation.failureCode }
        : { failureCode: undefined }),
      retryable: false,
      indeterminateReason: undefined,
      updatedAt: now,
      completedAt: now,
    });
    await ctx.db.patch("orchestrationRuns", run._id, {
      state: runState,
      failureCode: terminalState === "failed" ? reconciliation.failureCode : undefined,
      recoveryState: terminalState === "succeeded" ? "recovered" : "escalated",
      recoveryReference: undefined,
      completedStepIds,
      checkpointNodeId: nodeId,
      checkpointAt: now,
      checkpointSequence: run.checkpointSequence + 1,
      updatedAt: now,
    });
    const updated = await ctx.db.get("orchestrationSteps", step._id);
    if (!updated) throw new Error("Orchestration resolution update failed.");
    return publicStep(updated);
  },
});
