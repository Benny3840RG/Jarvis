import type { MutationCtx } from "./_generated/server.js";

type TerminalReceiptStatus = "succeeded" | "failed" | "indeterminate";

type ReceiptLike = {
  actionId: string;
  receiptKey: string;
  status: string;
  completedAt: number;
};

export type OmegaReconciliationResult =
  | "not-terminal"
  | "not-bound"
  | "already-reconciled"
  | "deferred-contract-state"
  | "evidence-conflict"
  | "evidence-capacity-exhausted"
  | "reconciled";

const MAX_EVIDENCE_PER_MISSION = 256;

function terminalStatus(status: string): TerminalReceiptStatus | null {
  if (status === "succeeded" || status === "failed" || status === "indeterminate") {
    return status;
  }
  return null;
}

export async function reconcileOmegaContractFromReceipt(
  ctx: MutationCtx,
  ownerId: string,
  receipt: ReceiptLike,
): Promise<OmegaReconciliationResult> {
  const status = terminalStatus(receipt.status);
  if (status === null) return "not-terminal";

  const contract = await ctx.db
    .query("omegaActionContracts")
    .withIndex("by_owner_and_tool_action_id", (q) =>
      q.eq("ownerId", ownerId).eq("toolActionId", receipt.actionId),
    )
    .unique();
  if (!contract) return "not-bound";

  if (contract.status === "reconciled") return "already-reconciled";
  if (contract.status !== "claimed") return "deferred-contract-state";

  const evidenceId = `tool-receipt:${receipt.receiptKey}`;
  const claim =
    status === "succeeded"
      ? `Governed tool action ${receipt.actionId} succeeded.`
      : status === "failed"
        ? `Governed tool action ${receipt.actionId} failed.`
        : `Governed tool action ${receipt.actionId} completed with an indeterminate outcome.`;
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
    updatedAt: receipt.completedAt,
  });
  return "reconciled";
}
