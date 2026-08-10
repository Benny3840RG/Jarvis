import type { MutationCtx } from "./_generated/server.js";
import { normaliseAuditPayload } from "./toolActionLogic.js";

export type OmegaExecutionBlockReason =
  | "omega-mission-not-executable"
  | "omega-contract-not-authorized"
  | "omega-contract-expired"
  | "omega-contract-authority-mismatch"
  | "omega-precondition-unsatisfied";

export type OmegaExecutionGateDecision =
  | { ok: true; contractId?: string }
  | { ok: false; blockReason: OmegaExecutionBlockReason };

export async function claimOmegaExecutionContract(
  ctx: MutationCtx,
  ownerId: string,
  action: {
    actionId: string;
    projectKey: string;
    requiredAuthority: "T0" | "T1" | "T2" | "T3";
  },
  claimId: string,
  now: number,
): Promise<OmegaExecutionGateDecision> {
  const contract = await ctx.db
    .query("omegaActionContracts")
    .withIndex("by_owner_and_tool_action_id", (q) =>
      q.eq("ownerId", ownerId).eq("toolActionId", action.actionId),
    )
    .unique();

  // Additive integration: unbound Jarvis actions keep their existing governed
  // execution path. Once bound, Omega becomes a mandatory same-transaction
  // precondition to the existing authoritative single-use claim.
  if (!contract) return { ok: true };
  if (contract.status !== "authorized") {
    return { ok: false, blockReason: "omega-contract-not-authorized" };
  }
  if (contract.authorityExpiresAt === undefined || contract.authorityExpiresAt <= now) {
    await ctx.db.patch("omegaActionContracts", contract._id, {
      status: "expired",
      updatedAt: now,
    });
    return { ok: false, blockReason: "omega-contract-expired" };
  }
  if (contract.requiredAuthority !== action.requiredAuthority) {
    return { ok: false, blockReason: "omega-contract-authority-mismatch" };
  }

  const mission = await ctx.db
    .query("omegaMissions")
    .withIndex("by_owner_and_mission_id", (q) =>
      q.eq("ownerId", ownerId).eq("missionId", contract.missionId),
    )
    .unique();
  if (
    !mission ||
    mission.projectKey !== action.projectKey ||
    !["active", "validating", "recovering"].includes(mission.state)
  ) {
    return { ok: false, blockReason: "omega-mission-not-executable" };
  }

  for (const evidenceId of contract.preconditionEvidenceRefs) {
    const evidence = await ctx.db
      .query("omegaEvidence")
      .withIndex("by_owner_mission_and_evidence_id", (q) =>
        q
          .eq("ownerId", ownerId)
          .eq("missionId", contract.missionId)
          .eq("evidenceId", evidenceId),
      )
      .unique();
    if (!evidence || (evidence.validUntil !== undefined && evidence.validUntil <= now)) {
      return { ok: false, blockReason: "omega-precondition-unsatisfied" };
    }
  }

  await ctx.db.patch("omegaActionContracts", contract._id, {
    status: "claimed",
    executionClaimId: claimId,
    updatedAt: now,
  });
  await ctx.db.insert("auditEvents", {
    ownerId,
    requestId: contract.missionId,
    scopeKey: mission.projectKey,
    eventType: "omega.contract.execution-claimed",
    actor: "tool",
    payload: normaliseAuditPayload({
      missionId: contract.missionId,
      contractId: contract.contractId,
      toolActionId: action.actionId,
      claimId,
    }),
    createdAt: now,
  });
  return { ok: true, contractId: contract.contractId };
}
