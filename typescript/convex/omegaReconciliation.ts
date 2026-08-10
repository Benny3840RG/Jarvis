import type { MutationCtx } from "./_generated/server.js";
import { normaliseAuditPayload } from "./toolActionLogic.js";

type ReceiptLike = {
  actionId: string;
  receiptId: string;
  receiptKey: string;
  status: string;
  tool: string;
  operation: string;
  completedAt: number;
};

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

export async function reconcileOmegaContractFromReceipt(
  ctx: MutationCtx,
  ownerId: string,
  receipt: ReceiptLike,
): Promise<void> {
  if (!["succeeded", "failed", "indeterminate"].includes(receipt.status)) return;

  const contract = await ctx.db
    .query("omegaActionContracts")
    .withIndex("by_owner_and_tool_action_id", (q) =>
      q.eq("ownerId", ownerId).eq("toolActionId", receipt.actionId),
    )
    .unique();
  if (!contract) return;

  const mission = await ctx.db
    .query("omegaMissions")
    .withIndex("by_owner_and_mission_id", (q) =>
      q.eq("ownerId", ownerId).eq("missionId", contract.missionId),
    )
    .unique();
  if (!mission) return;

  const evidenceId = `tool-receipt:${receipt.receiptKey}:${receipt.status}`;
  const existingEvidence = await ctx.db
    .query("omegaEvidence")
    .withIndex("by_owner_mission_and_evidence_id", (q) =>
      q.eq("ownerId", ownerId).eq("missionId", contract.missionId).eq("evidenceId", evidenceId),
    )
    .unique();
  if (!existingEvidence) {
    await ctx.db.insert("omegaEvidence", {
      ownerId,
      missionId: contract.missionId,
      evidenceId,
      claim: `Governed tool action ${receipt.actionId} produced receipt status ${receipt.status}.`,
      classification: "certain",
      sourceType: "direct-measurement",
      sourceRef: receipt.receiptKey,
      contradicts: [],
      createdAt: receipt.completedAt,
    });
  }

  if (receipt.status === "indeterminate") {
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
    }
    return;
  }

  const outcome = receipt.status as "succeeded" | "failed";
  if (contract.status === "reconciled") {
    if (
      contract.reconciledReceiptKey !== receipt.receiptKey ||
      contract.terminalOutcome !== outcome
    ) {
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
    }
    return;
  }

  if (contract.status !== "claimed" && contract.status !== "indeterminate") {
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
        priorStatus: contract.status,
        outcome,
      },
      createdAt: receipt.completedAt,
    });
    return;
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
}
