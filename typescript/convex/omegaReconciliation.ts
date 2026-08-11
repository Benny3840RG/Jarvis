import { normaliseAuditPayload } from "./toolActionLogic.js";
import { internal } from "./_generated/api.js";
import type { MutationCtx } from "./_generated/server.js";

type TerminalReceiptStatus = "succeeded" | "failed" | "indeterminate";

type ReceiptLike = {
  actionId: string;
  projectId: string;
  receiptId: string;
  receiptKey: string;
  status: string;
  tool: string;
  operation: string;
  completedAt: number;
};

export type OmegaReconciliationResult =
  | "not-terminal"
  | "not-bound"
  | "terminal-mission-immutable"
  | "already-reconciled"
  | "deferred-contract-state"
  | "receipt-identity-conflict"
  | "reconciliation-conflict"
  | "evidence-conflict"
  | "evidence-capacity-exhausted"
  | "indeterminate"
  | "reconciled";

const MAX_EVIDENCE_PER_MISSION = 256;

function terminalStatus(status: string): TerminalReceiptStatus | null {
  if (status === "succeeded" || status === "failed" || status === "indeterminate") {
    return status;
  }
  return null;
}

async function appendAudit(
  ctx: MutationCtx,
  input: {
    ownerId: string;
    missionId: string;
    projectKey: string;
    eventType: string;
    payload: Record<string, unknown>;
    createdAt: number;
  },
): Promise<void> {
  await ctx.db.insert("auditEvents", {
    ownerId: input.ownerId,
    requestId: input.missionId,
    scopeKey: input.projectKey,
    eventType: input.eventType,
    actor: "tool",
    payload: normaliseAuditPayload(input.payload),
    createdAt: input.createdAt,
  });
}

/**
 * The public receipt hook is intentionally scheduling-only. Callers may invoke
 * it in the same transaction that commits authoritative execution truth: the
 * scheduler registration commits atomically with that truth, while all Omega
 * state mutation happens later in `reconcileOmegaReceipt`.
 */
export async function reconcileOmegaContractFromReceipt(
  ctx: MutationCtx,
  ownerId: string,
  receipt: { receiptKey: string },
): Promise<void> {
  await ctx.scheduler.runAfter(0, internal.toolExecutionReceipts.reconcileOmegaReceipt, {
    ownerId,
    receiptKey: receipt.receiptKey,
  });
}

export async function applyOmegaContractReconciliationFromReceipt(
  ctx: MutationCtx,
  ownerId: string,
  receipt: ReceiptLike,
): Promise<OmegaReconciliationResult> {
  const status = terminalStatus(receipt.status);
  if (status === null) return "not-terminal";
  if (!Number.isFinite(receipt.completedAt) || receipt.completedAt < 0) {
    return "reconciliation-conflict";
  }

  const contract = await ctx.db
    .query("omegaActionContracts")
    .withIndex("by_owner_and_tool_action_id", (q) =>
      q.eq("ownerId", ownerId).eq("toolActionId", receipt.actionId),
    )
    .unique();
  if (!contract) return "not-bound";

  const mission = await ctx.db
    .query("omegaMissions")
    .withIndex("by_owner_and_mission_id", (q) =>
      q.eq("ownerId", ownerId).eq("missionId", contract.missionId),
    )
    .unique();
  if (!mission) return "reconciliation-conflict";
  if (mission.state === "complete" || mission.state === "retired") {
    return "terminal-mission-immutable";
  }

  const action = await ctx.db
    .query("toolActions")
    .withIndex("by_owner_and_action_id", (q) =>
      q.eq("ownerId", ownerId).eq("actionId", receipt.actionId),
    )
    .unique();
  const projectMatches =
    action !== null &&
    action.projectKey === mission.projectKey &&
    receipt.projectId === mission.projectKey;
  const toolMatches = action !== null && receipt.tool === action.tool;
  const operationMatches = action !== null && receipt.operation === action.operation;
  const claimMatches =
    action !== null &&
    action.singleUseClaimId !== undefined &&
    contract.executionClaimId !== undefined &&
    action.singleUseClaimId === contract.executionClaimId;

  if (!projectMatches || !toolMatches || !operationMatches || !claimMatches) {
    if (contract.status !== "conflicted") {
      await ctx.db.patch("omegaActionContracts", contract._id, {
        status: "conflicted",
        updatedAt: receipt.completedAt,
      });
      await appendAudit(ctx, {
        ownerId,
        missionId: contract.missionId,
        projectKey: mission.projectKey,
        eventType: "omega.contract.receipt-identity-conflict",
        payload: {
          missionId: contract.missionId,
          contractId: contract.contractId,
          toolActionId: receipt.actionId,
          receiptKey: receipt.receiptKey,
          projectMatches,
          toolMatches,
          operationMatches,
          claimMatches,
        },
        createdAt: receipt.completedAt,
      });
    }
    return "receipt-identity-conflict";
  }

  if (status === "indeterminate") {
    if (contract.status === "claimed") {
      await ctx.db.patch("omegaActionContracts", contract._id, {
        status: "indeterminate",
        updatedAt: receipt.completedAt,
      });
      await appendAudit(ctx, {
        ownerId,
        missionId: contract.missionId,
        projectKey: mission.projectKey,
        eventType: "omega.contract.indeterminate",
        payload: {
          missionId: contract.missionId,
          contractId: contract.contractId,
          toolActionId: receipt.actionId,
          receiptKey: receipt.receiptKey,
        },
        createdAt: receipt.completedAt,
      });
      return "indeterminate";
    }
    if (contract.status === "indeterminate") return "indeterminate";
    if (contract.status === "reconciled") return "already-reconciled";
    return "deferred-contract-state";
  }

  const outcome = status;
  if (contract.status === "reconciled") {
    if (
      contract.reconciledReceiptKey === receipt.receiptKey &&
      contract.terminalOutcome === outcome
    ) {
      return "already-reconciled";
    }
    await ctx.db.patch("omegaActionContracts", contract._id, {
      status: "conflicted",
      updatedAt: receipt.completedAt,
    });
    await appendAudit(ctx, {
      ownerId,
      missionId: contract.missionId,
      projectKey: mission.projectKey,
      eventType: "omega.contract.reconciliation-conflict",
      payload: {
        missionId: contract.missionId,
        contractId: contract.contractId,
        toolActionId: receipt.actionId,
        receiptKey: receipt.receiptKey,
        outcome,
      },
      createdAt: receipt.completedAt,
    });
    return "reconciliation-conflict";
  }
  if (contract.status !== "claimed" && contract.status !== "indeterminate") {
    return "deferred-contract-state";
  }

  const evidenceId = `tool-receipt:${receipt.receiptKey}:${outcome}`;
  const claim = `Governed tool action ${receipt.actionId} produced receipt status ${outcome}.`;
  const existingEvidence = await ctx.db
    .query("omegaEvidence")
    .withIndex("by_owner_mission_and_evidence_id", (q) =>
      q.eq("ownerId", ownerId).eq("missionId", contract.missionId).eq("evidenceId", evidenceId),
    )
    .unique();

  if (existingEvidence) {
    if (
      existingEvidence.claim !== claim ||
      existingEvidence.classification !== "certain" ||
      existingEvidence.sourceType !== "direct-measurement" ||
      existingEvidence.sourceRef !== receipt.receiptKey
    ) {
      return "evidence-conflict";
    }
  } else {
    const evidenceRows = await ctx.db
      .query("omegaEvidence")
      .withIndex("by_owner_and_mission_id", (q) =>
        q.eq("ownerId", ownerId).eq("missionId", contract.missionId),
      )
      .take(MAX_EVIDENCE_PER_MISSION + 1);
    if (evidenceRows.length >= MAX_EVIDENCE_PER_MISSION) {
      return "evidence-capacity-exhausted";
    }

    await ctx.db.insert("omegaEvidence", {
      ownerId,
      missionId: contract.missionId,
      evidenceId,
      claim,
      classification: "certain",
      sourceType: "direct-measurement",
      sourceRef: receipt.receiptKey,
      contradicts: [],
      createdAt: receipt.completedAt,
    });
  }

  await ctx.db.patch("omegaActionContracts", contract._id, {
    status: "reconciled",
    terminalOutcome: outcome,
    reconciledReceiptKey: receipt.receiptKey,
    reconciledAt: receipt.completedAt,
    updatedAt: receipt.completedAt,
  });
  await appendAudit(ctx, {
    ownerId,
    missionId: contract.missionId,
    projectKey: mission.projectKey,
    eventType: "omega.contract.reconciled",
    payload: {
      missionId: contract.missionId,
      contractId: contract.contractId,
      toolActionId: receipt.actionId,
      receiptKey: receipt.receiptKey,
      outcome,
    },
    createdAt: receipt.completedAt,
  });
  return "reconciled";
}
