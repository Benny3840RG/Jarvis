import type { MutationCtx } from "./_generated/server.js";

export type OmegaExecutionBlockReason =
  | "omega-mission-not-executable"
  | "omega-contract-not-authorized"
  | "omega-contract-expired"
  | "omega-contract-authority-mismatch";

export type OmegaExecutionGateDecision =
  | { ok: true; contractId?: string }
  | { ok: false; blockReason: OmegaExecutionBlockReason };

function missionIsExecutable(state: string): boolean {
  return state === "active" || state === "validating" || state === "recovering";
}

export async function checkOmegaExecutionGate(
  ctx: MutationCtx,
  ownerId: string,
  action: {
    actionId: string;
    projectKey: string;
    requiredAuthority: string;
  },
  now: number,
): Promise<OmegaExecutionGateDecision> {
  const contract = await ctx.db
    .query("omegaActionContracts")
    .withIndex("by_owner_and_tool_action_id", (q) =>
      q.eq("ownerId", ownerId).eq("toolActionId", action.actionId),
    )
    .unique();

  if (!contract) return { ok: true };

  if (contract.status !== "authorized") {
    return { ok: false, blockReason: "omega-contract-not-authorized" };
  }
  if (contract.authorityExpiresAt !== undefined && contract.authorityExpiresAt <= now) {
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
    !missionIsExecutable(mission.state)
  ) {
    return { ok: false, blockReason: "omega-mission-not-executable" };
  }

  return { ok: true, contractId: contract.contractId };
}

export async function markOmegaExecutionClaimed(
  ctx: MutationCtx,
  ownerId: string,
  actionId: string,
  now: number,
): Promise<void> {
  const contract = await ctx.db
    .query("omegaActionContracts")
    .withIndex("by_owner_and_tool_action_id", (q) =>
      q.eq("ownerId", ownerId).eq("toolActionId", actionId),
    )
    .unique();
  if (!contract) return;
  if (contract.status !== "authorized") {
    throw new Error("Omega contract lost authorization before execution claim was recorded.");
  }

  const action = await ctx.db
    .query("toolActions")
    .withIndex("by_owner_and_action_id", (q) =>
      q.eq("ownerId", ownerId).eq("actionId", actionId),
    )
    .unique();
  if (!action?.singleUseClaimId) {
    throw new Error(
      "Omega contract execution claim requires the authoritative tool-action claim ID.",
    );
  }

  await ctx.db.patch("omegaActionContracts", contract._id, {
    status: "claimed",
    executionClaimId: action.singleUseClaimId,
    updatedAt: now,
  });
}
