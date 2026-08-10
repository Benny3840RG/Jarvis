import { v } from "convex/values";

import { requireOwner } from "./authHelpers.js";
import {
  isApprovalExpired,
  normaliseAuditPayload,
  normaliseToolArguments,
} from "./toolActionLogic.js";
import {
  omegaActionContractDocumentValidator,
  omegaReversibilityClassValidator,
  omegaRiskClassValidator,
} from "./omegaValidators.js";
import { mutation, query, type MutationCtx } from "./_generated/server.js";

const MAX_ID_LENGTH = 256;
const MAX_INTENT_LENGTH = 8_192;
const MAX_ROLLBACK_LENGTH = 16_384;
const MAX_PRECONDITIONS = 20;
const MAX_CONTRACTS_PER_MISSION = 200;
const RISK_RANK = { R0: 0, R1: 1, R2: 2, R3: 3, R4: 4 } as const;
const EXECUTABLE_MISSION_STATES = new Set(["active", "validating", "recovering"]);

function cleanText(value: string, label: string, maxLength = MAX_ID_LENGTH): string {
  const cleaned = value.trim();
  if (!cleaned) throw new Error(`${label} cannot be empty.`);
  if (cleaned.length > maxLength) {
    throw new Error(`${label} cannot exceed ${maxLength} characters.`);
  }
  return cleaned;
}

function uniqueStrings(values: readonly string[], label: string, maxItems: number): string[] {
  if (values.length > maxItems) throw new Error(`${label} cannot exceed ${maxItems} values.`);
  const cleaned = values.map((value) => cleanText(value, label));
  if (new Set(cleaned).size !== cleaned.length) {
    throw new Error(`${label} values must be unique.`);
  }
  return cleaned;
}

function sameJson(left: unknown, right: unknown): boolean {
  return JSON.stringify(left) === JSON.stringify(right);
}

async function appendAudit(
  ctx: MutationCtx,
  input: {
    ownerId: string;
    missionId: string;
    projectKey: string;
    eventType: string;
    actor: "agent" | "tool";
    payload: Record<string, unknown>;
    createdAt: number;
  },
): Promise<void> {
  await ctx.db.insert("auditEvents", {
    ownerId: input.ownerId,
    requestId: input.missionId,
    scopeKey: input.projectKey,
    eventType: input.eventType,
    actor: input.actor,
    payload: normaliseAuditPayload(input.payload),
    createdAt: input.createdAt,
  });
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
    preconditionEvidenceRefs: v.array(v.string()),
    rollbackPlan: v.optional(v.string()),
  },
  returns: omegaActionContractDocumentValidator,
  handler: async (ctx, args) => {
    const ownerId = requireOwner(args.serviceToken);
    const missionId = cleanText(args.missionId, "Mission ID");
    const contractId = cleanText(args.contractId, "Contract ID");
    const toolActionId = cleanText(args.toolActionId, "Tool action ID");
    const intent = cleanText(args.intent, "Contract intent", MAX_INTENT_LENGTH);
    const rollbackPlan =
      args.rollbackPlan === undefined
        ? undefined
        : cleanText(args.rollbackPlan, "Rollback plan", MAX_ROLLBACK_LENGTH);
    const preconditionEvidenceRefs = uniqueStrings(
      args.preconditionEvidenceRefs,
      "Precondition evidence reference",
      MAX_PRECONDITIONS,
    );

    const mission = await ctx.db
      .query("omegaMissions")
      .withIndex("by_owner_and_mission_id", (q) =>
        q.eq("ownerId", ownerId).eq("missionId", missionId),
      )
      .unique();
    if (!mission) throw new Error("Omega mission does not exist.");
    if (!EXECUTABLE_MISSION_STATES.has(mission.state)) {
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
    if (["rejected", "revoked", "expired"].includes(action.state)) {
      throw new Error(`Tool action is ${action.state}; it cannot be bound to an Omega contract.`);
    }
    if (!action.destructive) {
      throw new Error(
        "Omega Pass 2 contracts require a destructive governed action so Jarvis assigns single-use consumption.",
      );
    }
    if (args.riskClass !== "R3" && args.riskClass !== "R4") {
      throw new Error("Destructive Omega contracts require risk class R3 or R4.");
    }
    if (RISK_RANK[mission.riskClass] < RISK_RANK[args.riskClass]) {
      throw new Error(
        "Omega mission risk class cannot be lower than its action contract risk class.",
      );
    }

    const now = Date.now();
    for (const evidenceId of preconditionEvidenceRefs) {
      const evidence = await ctx.db
        .query("omegaEvidence")
        .withIndex("by_owner_mission_and_evidence_id", (q) =>
          q.eq("ownerId", ownerId).eq("missionId", missionId).eq("evidenceId", evidenceId),
        )
        .unique();
      if (!evidence) {
        throw new Error(`Omega contract precondition evidence is missing: ${evidenceId}.`);
      }
      if (evidence.validUntil !== undefined && evidence.validUntil <= now) {
        throw new Error(`Omega contract precondition evidence is expired: ${evidenceId}.`);
      }
    }

    const scope = normaliseToolArguments(action.arguments);
    const existingContract = await ctx.db
      .query("omegaActionContracts")
      .withIndex("by_owner_mission_and_contract_id", (q) =>
        q.eq("ownerId", ownerId).eq("missionId", missionId).eq("contractId", contractId),
      )
      .unique();
    if (existingContract) {
      const same =
        existingContract.toolActionId === toolActionId &&
        existingContract.intent === intent &&
        existingContract.riskClass === args.riskClass &&
        existingContract.reversibilityClass === args.reversibilityClass &&
        existingContract.requiredAuthority === action.requiredAuthority &&
        existingContract.rollbackPlan === rollbackPlan &&
        sameJson(existingContract.scope, scope) &&
        sameJson(existingContract.preconditionEvidenceRefs, preconditionEvidenceRefs);
      if (!same) throw new Error("Omega contract ID already exists with different contents.");
      return existingContract;
    }

    const existingBinding = await ctx.db
      .query("omegaActionContracts")
      .withIndex("by_owner_and_tool_action_id", (q) =>
        q.eq("ownerId", ownerId).eq("toolActionId", toolActionId),
      )
      .unique();
    if (existingBinding) throw new Error("Tool action is already bound to another Omega contract.");

    const contractCount = await ctx.db
      .query("omegaActionContracts")
      .withIndex("by_owner_and_mission_id", (q) =>
        q.eq("ownerId", ownerId).eq("missionId", missionId),
      )
      .take(MAX_CONTRACTS_PER_MISSION);
    if (contractCount.length >= MAX_CONTRACTS_PER_MISSION) {
      throw new Error(
        `Omega action contract limit of ${MAX_CONTRACTS_PER_MISSION} per mission reached.`,
      );
    }

    const id = await ctx.db.insert("omegaActionContracts", {
      ownerId,
      missionId,
      contractId,
      toolActionId,
      intent,
      riskClass: args.riskClass,
      reversibilityClass: args.reversibilityClass,
      requiredAuthority: action.requiredAuthority,
      scope,
      preconditionEvidenceRefs,
      ...(rollbackPlan === undefined ? {} : { rollbackPlan }),
      status: "proposed",
      createdAt: now,
      updatedAt: now,
    });
    await appendAudit(ctx, {
      ownerId,
      missionId,
      projectKey: mission.projectKey,
      eventType: "omega.contract.created",
      actor: "agent",
      payload: { missionId, contractId, toolActionId, riskClass: args.riskClass },
      createdAt: now,
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
  },
  returns: omegaActionContractDocumentValidator,
  handler: async (ctx, args) => {
    const ownerId = requireOwner(args.serviceToken);
    const missionId = cleanText(args.missionId, "Mission ID");
    const contractId = cleanText(args.contractId, "Contract ID");
    const contract = await ctx.db
      .query("omegaActionContracts")
      .withIndex("by_owner_mission_and_contract_id", (q) =>
        q.eq("ownerId", ownerId).eq("missionId", missionId).eq("contractId", contractId),
      )
      .unique();
    if (!contract) throw new Error("Omega action contract does not exist.");
    if (contract.status !== "proposed" && contract.status !== "authorized") {
      throw new Error(`Omega action contract is ${contract.status}; it cannot be authorized.`);
    }

    const mission = await ctx.db
      .query("omegaMissions")
      .withIndex("by_owner_and_mission_id", (q) =>
        q.eq("ownerId", ownerId).eq("missionId", missionId),
      )
      .unique();
    if (!mission || !EXECUTABLE_MISSION_STATES.has(mission.state)) {
      throw new Error("Omega mission is not executable.");
    }

    const action = await ctx.db
      .query("toolActions")
      .withIndex("by_owner_and_action_id", (q) =>
        q.eq("ownerId", ownerId).eq("actionId", contract.toolActionId),
      )
      .unique();
    if (!action || action.projectKey !== mission.projectKey || action.state !== "approved") {
      throw new Error(
        "Bound tool action must be approved before the Omega contract is authorized.",
      );
    }
    if (action.consumptionPolicy !== "single-use") {
      throw new Error("Bound tool action is not governed as single-use.");
    }
    if (action.singleUseClaimId !== undefined) {
      throw new Error("Bound tool action has already been claimed for execution.");
    }
    if (action.requiredAuthority !== contract.requiredAuthority) {
      throw new Error("Bound tool action authority no longer matches the Omega contract.");
    }

    const now = Date.now();
    if (
      action.approvalExpiryPolicy === undefined ||
      action.approvalExpiresAt === undefined ||
      isApprovalExpired(
        { policy: action.approvalExpiryPolicy, expiresAt: action.approvalExpiresAt },
        now,
      )
    ) {
      throw new Error("Bound tool action approval is expired or lacks a finite authority window.");
    }

    for (const evidenceId of contract.preconditionEvidenceRefs) {
      const evidence = await ctx.db
        .query("omegaEvidence")
        .withIndex("by_owner_mission_and_evidence_id", (q) =>
          q.eq("ownerId", ownerId).eq("missionId", missionId).eq("evidenceId", evidenceId),
        )
        .unique();
      if (!evidence || (evidence.validUntil !== undefined && evidence.validUntil <= now)) {
        throw new Error(
          `Omega contract precondition evidence is not currently valid: ${evidenceId}.`,
        );
      }
    }

    if (contract.status === "authorized") return contract;

    await ctx.db.patch("omegaActionContracts", contract._id, {
      approvalRef: `tool-action:${action._id}`,
      authorityExpiresAt: action.approvalExpiresAt,
      status: "authorized",
      updatedAt: now,
    });
    await appendAudit(ctx, {
      ownerId,
      missionId,
      projectKey: mission.projectKey,
      eventType: "omega.contract.authorized",
      actor: "agent",
      payload: {
        missionId,
        contractId,
        toolActionId: action.actionId,
        authorityExpiresAt: action.approvalExpiresAt,
      },
      createdAt: now,
    });
    const updated = await ctx.db.get("omegaActionContracts", contract._id);
    if (!updated) throw new Error("Omega action contract authorization failed.");
    return updated;
  },
});

export const deny = mutation({
  args: {
    serviceToken: v.string(),
    missionId: v.string(),
    contractId: v.string(),
    reason: v.string(),
  },
  returns: omegaActionContractDocumentValidator,
  handler: async (ctx, args) => {
    const ownerId = requireOwner(args.serviceToken);
    const missionId = cleanText(args.missionId, "Mission ID");
    const contractId = cleanText(args.contractId, "Contract ID");
    const reason = cleanText(args.reason, "Denial reason", MAX_INTENT_LENGTH);
    const contract = await ctx.db
      .query("omegaActionContracts")
      .withIndex("by_owner_mission_and_contract_id", (q) =>
        q.eq("ownerId", ownerId).eq("missionId", missionId).eq("contractId", contractId),
      )
      .unique();
    if (!contract) throw new Error("Omega action contract does not exist.");
    if (contract.status === "denied") {
      if (contract.denialReason === reason) return contract;
      throw new Error("Omega action contract was already denied for a different reason.");
    }
    if (contract.status !== "proposed" && contract.status !== "authorized") {
      throw new Error(`Omega action contract is ${contract.status}; it cannot be denied safely.`);
    }
    const mission = await ctx.db
      .query("omegaMissions")
      .withIndex("by_owner_and_mission_id", (q) =>
        q.eq("ownerId", ownerId).eq("missionId", missionId),
      )
      .unique();
    if (!mission) throw new Error("Omega mission does not exist.");

    const now = Date.now();
    await ctx.db.patch("omegaActionContracts", contract._id, {
      status: "denied",
      denialReason: reason,
      updatedAt: now,
    });
    await appendAudit(ctx, {
      ownerId,
      missionId,
      projectKey: mission.projectKey,
      eventType: "omega.contract.denied",
      actor: "agent",
      payload: { missionId, contractId, toolActionId: contract.toolActionId, reason },
      createdAt: now,
    });
    const updated = await ctx.db.get("omegaActionContracts", contract._id);
    if (!updated) throw new Error("Omega action contract denial failed.");
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

export const listForMission = query({
  args: { serviceToken: v.string(), missionId: v.string(), limit: v.optional(v.number()) },
  returns: v.array(omegaActionContractDocumentValidator),
  handler: async (ctx, args) => {
    const ownerId = requireOwner(args.serviceToken);
    const missionId = cleanText(args.missionId, "Mission ID");
    const limit = args.limit ?? 50;
    if (!Number.isInteger(limit) || limit < 1 || limit > 100) {
      throw new Error("Omega contract list limit must be an integer between 1 and 100.");
    }
    return ctx.db
      .query("omegaActionContracts")
      .withIndex("by_owner_and_mission_id", (q) =>
        q.eq("ownerId", ownerId).eq("missionId", missionId),
      )
      .order("desc")
      .take(limit);
  },
});
