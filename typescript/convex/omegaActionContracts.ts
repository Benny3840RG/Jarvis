import { v } from "convex/values";

import { requireOwner } from "./authHelpers.js";
import {
  omegaActionContractDocumentValidator,
  omegaReversibilityClassValidator,
  omegaRiskClassValidator,
} from "./omegaValidators.js";
import { mutation, query } from "./_generated/server.js";

const MAX_CONTRACTS_PER_MISSION = 128;
const MAX_PRECONDITIONS = 32;
const TERMINAL_RECEIPT_STATUSES = new Set(["succeeded", "failed", "indeterminate"]);

function cleanText(value: string, label: string): string {
  const cleaned = value.trim();
  if (!cleaned) throw new Error(`${label} cannot be empty.`);
  return cleaned;
}

function uniqueStrings(values: readonly string[], label: string): string[] {
  if (values.length > MAX_PRECONDITIONS) {
    throw new Error(`${label} cannot contain more than ${MAX_PRECONDITIONS} values.`);
  }
  const cleaned = values.map((value) => cleanText(value, label));
  if (new Set(cleaned).size !== cleaned.length) {
    throw new Error(`${label} values must be unique.`);
  }
  return cleaned;
}

function sameStrings(left: readonly string[], right: readonly string[]): boolean {
  return left.length === right.length && left.every((value, index) => value === right[index]);
}

function sameRecord(left: Record<string, unknown>, right: Record<string, unknown>): boolean {
  return JSON.stringify(left) === JSON.stringify(right);
}

export const create = mutation({
  args: {
    serviceToken: v.string(),
    missionId: v.string(),
    contractId: v.string(),
    toolActionId: v.string(),
    intent: v.string(),
    riskClass: omegaRiskClassValidator,
    reversibilityClass: omegaReversibilityClassValidator,
    requiredAuthority: v.string(),
    scope: v.record(v.string(), v.any()),
    preconditions: v.array(v.string()),
    rollbackPlan: v.optional(v.string()),
  },
  returns: omegaActionContractDocumentValidator,
  handler: async (ctx, args) => {
    const ownerId = requireOwner(args.serviceToken);
    const missionId = cleanText(args.missionId, "Mission ID");
    const contractId = cleanText(args.contractId, "Contract ID");
    const toolActionId = cleanText(args.toolActionId, "Tool action ID");
    const requiredAuthority = cleanText(args.requiredAuthority, "Required authority");
    const intent = cleanText(args.intent, "Contract intent");
    const preconditions = uniqueStrings(args.preconditions, "Precondition");
    const rollbackPlan =
      args.rollbackPlan === undefined
        ? undefined
        : cleanText(args.rollbackPlan, "Rollback plan");

    const mission = await ctx.db
      .query("omegaMissions")
      .withIndex("by_owner_and_mission_id", (q) =>
        q.eq("ownerId", ownerId).eq("missionId", missionId),
      )
      .unique();
    if (!mission) throw new Error("Omega mission does not exist.");
    if (!["active", "validating", "recovering"].includes(mission.state)) {
      throw new Error(`Omega mission is ${mission.state}; it cannot create executable contracts.`);
    }

    const action = await ctx.db
      .query("toolActions")
      .withIndex("by_owner_and_action_id", (q) =>
        q.eq("ownerId", ownerId).eq("actionId", toolActionId),
      )
      .unique();
    if (!action || action.projectKey !== mission.projectKey) {
      throw new Error("Tool action does not exist in the Omega mission project.");
    }
    if (action.consumptionPolicy !== "single-use") {
      throw new Error("Omega Pass 2 contracts require a single-use governed tool action.");
    }
    if (action.singleUseClaimId !== undefined) {
      throw new Error("Consumed tool actions cannot be bound to a new Omega contract.");
    }
    if (action.requiredAuthority !== requiredAuthority) {
      throw new Error("Omega contract authority must match the governed tool action.");
    }

    const priorReceipts = await ctx.db
      .query("toolExecutionReceipts")
      .withIndex("by_owner_and_action_id", (q) =>
        q.eq("ownerId", ownerId).eq("actionId", toolActionId),
      )
      .take(20);
    if (priorReceipts.some((receipt) => TERMINAL_RECEIPT_STATUSES.has(receipt.status))) {
      throw new Error("Tool actions with a terminal execution receipt cannot be newly bound.");
    }

    const existingContract = await ctx.db
      .query("omegaActionContracts")
      .withIndex("by_owner_mission_and_contract_id", (q) =>
        q.eq("ownerId", ownerId).eq("missionId", missionId).eq("contractId", contractId),
      )
      .unique();
    if (existingContract) {
      if (
        existingContract.toolActionId !== toolActionId ||
        existingContract.intent !== intent ||
        existingContract.riskClass !== args.riskClass ||
        existingContract.reversibilityClass !== args.reversibilityClass ||
        existingContract.requiredAuthority !== requiredAuthority ||
        !sameRecord(existingContract.scope, args.scope) ||
        !sameStrings(existingContract.preconditions, preconditions) ||
        existingContract.rollbackPlan !== rollbackPlan
      ) {
        throw new Error("Omega contract ID already exists with different contents.");
      }
      return existingContract;
    }

    const existingBinding = await ctx.db
      .query("omegaActionContracts")
      .withIndex("by_owner_and_tool_action_id", (q) =>
        q.eq("ownerId", ownerId).eq("toolActionId", toolActionId),
      )
      .unique();
    if (existingBinding) {
      throw new Error("Tool action is already bound to another Omega contract.");
    }

    const missionContracts = await ctx.db
      .query("omegaActionContracts")
      .withIndex("by_owner_and_mission_id", (q) =>
        q.eq("ownerId", ownerId).eq("missionId", missionId),
      )
      .take(MAX_CONTRACTS_PER_MISSION + 1);
    if (missionContracts.length >= MAX_CONTRACTS_PER_MISSION) {
      throw new Error(`Omega mission contract limit of ${MAX_CONTRACTS_PER_MISSION} reached.`);
    }

    const now = Date.now();
    const id = await ctx.db.insert("omegaActionContracts", {
      ownerId,
      missionId,
      contractId,
      toolActionId,
      intent,
      riskClass: args.riskClass,
      reversibilityClass: args.reversibilityClass,
      requiredAuthority,
      scope: args.scope,
      preconditions,
      ...(rollbackPlan === undefined ? {} : { rollbackPlan }),
      status: "proposed",
      createdAt: now,
      updatedAt: now,
    });
    const created = await ctx.db.get("omegaActionContracts", id);
    if (!created) throw new Error("Omega action contract creation failed.");
    return created;
  },
});

export const authorize = mutation({
  args: {
    serviceToken: v.string(),
    missionId: v.string(),
    contractId: v.string(),
    approvalRef: v.string(),
    authorityExpiresAt: v.optional(v.number()),
    now: v.optional(v.number()),
  },
  returns: omegaActionContractDocumentValidator,
  handler: async (ctx, args) => {
    const ownerId = requireOwner(args.serviceToken);
    const missionId = cleanText(args.missionId, "Mission ID");
    const contractId = cleanText(args.contractId, "Contract ID");
    const approvalRef = cleanText(args.approvalRef, "Approval reference");

    const contract = await ctx.db
      .query("omegaActionContracts")
      .withIndex("by_owner_mission_and_contract_id", (q) =>
        q.eq("ownerId", ownerId).eq("missionId", missionId).eq("contractId", contractId),
      )
      .unique();
    if (!contract) throw new Error("Omega action contract does not exist.");

    const now = args.now ?? Date.now();
    if (contract.status === "authorized") {
      if (contract.approvalRef !== approvalRef) {
        throw new Error("Omega action contract is already authorized with different authority.");
      }
      return contract;
    }
    if (contract.status !== "proposed") {
      throw new Error(`Omega action contract is ${contract.status}; it cannot be authorized.`);
    }

    const mission = await ctx.db
      .query("omegaMissions")
      .withIndex("by_owner_and_mission_id", (q) =>
        q.eq("ownerId", ownerId).eq("missionId", missionId),
      )
      .unique();
    if (!mission || !["active", "validating", "recovering"].includes(mission.state)) {
      throw new Error("Omega mission is not executable.");
    }

    const action = await ctx.db
      .query("toolActions")
      .withIndex("by_owner_and_action_id", (q) =>
        q.eq("ownerId", ownerId).eq("actionId", contract.toolActionId),
      )
      .unique();
    if (!action || action.state !== "approved") {
      throw new Error(
        "Bound tool action must be approved before the Omega contract is authorized.",
      );
    }
    if (action.consumptionPolicy !== "single-use" || action.singleUseClaimId !== undefined) {
      throw new Error("Bound tool action is no longer an unconsumed single-use action.");
    }
    if (action.requiredAuthority !== contract.requiredAuthority) {
      throw new Error("Bound tool action authority no longer matches the Omega contract.");
    }

    const authorityExpiresAt =
      args.authorityExpiresAt === undefined
        ? action.approvalExpiresAt
        : Math.min(args.authorityExpiresAt, action.approvalExpiresAt ?? args.authorityExpiresAt);
    if (authorityExpiresAt !== undefined && authorityExpiresAt <= now) {
      throw new Error("Omega contract authority is already expired.");
    }

    await ctx.db.patch("omegaActionContracts", contract._id, {
      approvalRef,
      ...(authorityExpiresAt === undefined ? {} : { authorityExpiresAt }),
      status: "authorized",
      updatedAt: now,
    });
    const updated = await ctx.db.get("omegaActionContracts", contract._id);
    if (!updated) throw new Error("Omega action contract authorization failed.");
    return updated;
  },
});

export const getByToolAction = query({
  args: { serviceToken: v.string(), toolActionId: v.string() },
  returns: v.union(omegaActionContractDocumentValidator, v.null()),
  handler: async (ctx, args) => {
    const ownerId = requireOwner(args.serviceToken);
    const toolActionId = cleanText(args.toolActionId, "Tool action ID");
    return ctx.db
      .query("omegaActionContracts")
      .withIndex("by_owner_and_tool_action_id", (q) =>
        q.eq("ownerId", ownerId).eq("toolActionId", toolActionId),
      )
      .unique();
  },
});
