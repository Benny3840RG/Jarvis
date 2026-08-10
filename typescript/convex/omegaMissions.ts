import { v } from "convex/values";

import { requireOwner } from "./authHelpers.js";
import { normaliseAuditPayload } from "./toolActionLogic.js";
import {
  omegaAcceptanceCriterionValidator,
  omegaAutonomyClassValidator,
  omegaEvidenceClassificationValidator,
  omegaEvidenceDocumentValidator,
  omegaEvidenceSourceTypeValidator,
  omegaMissionDocumentValidator,
  omegaMissionStateValidator,
  omegaReversibilityClassValidator,
  omegaRiskClassValidator,
  omegaValidationMethodValidator,
  omegaValidationProofDocumentValidator,
  omegaValidationResultValidator,
} from "./omegaValidators.js";
import { mutation, query, type MutationCtx } from "./_generated/server.js";
import { canTransitionOmegaMission, evaluateOmegaCompletion } from "../src/omega/policy.js";

const POLICY_VERSION = "omega-sigma:v1";
const MAX_ACCEPTANCE_CRITERIA = 100;
const MAX_EVIDENCE_REFS = 100;
const MAX_EVIDENCE_PER_MISSION = 500;
const MAX_PROOFS_PER_MISSION = 500;
const MAX_CONTRACTS_PER_MISSION = 200;
const MAX_ID_LENGTH = 256;
const MAX_OBJECTIVE_LENGTH = 16_384;
const MAX_STATEMENT_LENGTH = 8_192;
const MAX_CLAIM_LENGTH = 16_384;
const MAX_SOURCE_REF_LENGTH = 2_048;
const MUTABLE_MISSION_STATES = new Set([
  "initializing",
  "active",
  "validating",
  "degraded",
  "recovering",
  "blocked",
  "partial",
]);

function cleanText(value: string, label: string, maxLength = MAX_ID_LENGTH): string {
  const cleaned = value.trim();
  if (!cleaned) throw new Error(`${label} cannot be empty.`);
  if (cleaned.length > maxLength) throw new Error(`${label} cannot exceed ${maxLength} characters.`);
  return cleaned;
}

function uniqueStrings(values: readonly string[], label: string, maxItems = MAX_EVIDENCE_REFS): string[] {
  if (values.length > maxItems) throw new Error(`${label} cannot exceed ${maxItems} values.`);
  const cleaned = values.map((value) => cleanText(value, label));
  if (new Set(cleaned).size !== cleaned.length) throw new Error(`${label} values must be unique.`);
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
    payload: Record<string, unknown>;
    createdAt: number;
  },
): Promise<void> {
  await ctx.db.insert("auditEvents", {
    ownerId: input.ownerId,
    requestId: input.missionId,
    scopeKey: input.projectKey,
    eventType: input.eventType,
    actor: "agent",
    payload: normaliseAuditPayload(input.payload),
    createdAt: input.createdAt,
  });
}

async function requireMission(ctx: MutationCtx, ownerId: string, missionId: string) {
  const mission = await ctx.db
    .query("omegaMissions")
    .withIndex("by_owner_and_mission_id", (q) => q.eq("ownerId", ownerId).eq("missionId", missionId))
    .unique();
  if (!mission) throw new Error("Omega mission does not exist.");
  return mission;
}

function requireMutableMission(state: string): void {
  if (!MUTABLE_MISSION_STATES.has(state)) {
    throw new Error(`Omega mission is ${state}; its evidence and validation state are immutable.`);
  }
}

async function assertMissionCapacity(
  ctx: MutationCtx,
  ownerId: string,
  missionId: string,
  table: "omegaEvidence" | "omegaValidationProofs",
  max: number,
  label: string,
): Promise<void> {
  const rows = await ctx.db
    .query(table)
    .withIndex("by_owner_and_mission_id", (q) => q.eq("ownerId", ownerId).eq("missionId", missionId))
    .take(max);
  if (rows.length >= max) throw new Error(`${label} limit of ${max} per mission has been reached.`);
}

export const create = mutation({
  args: {
    serviceToken: v.string(),
    missionId: v.string(),
    projectKey: v.string(),
    objective: v.string(),
    riskClass: omegaRiskClassValidator,
    autonomyClass: omegaAutonomyClassValidator,
    reversibilityClass: omegaReversibilityClassValidator,
    uncertaintyBudget: v.number(),
    acceptanceCriteria: v.array(omegaAcceptanceCriterionValidator),
  },
  returns: omegaMissionDocumentValidator,
  handler: async (ctx, args) => {
    const ownerId = requireOwner(args.serviceToken);
    const missionId = cleanText(args.missionId, "Mission ID");
    const projectKey = cleanText(args.projectKey, "Project key");
    const objective = cleanText(args.objective, "Objective", MAX_OBJECTIVE_LENGTH);
    if (!Number.isFinite(args.uncertaintyBudget) || args.uncertaintyBudget < 0 || args.uncertaintyBudget > 1) {
      throw new Error("Uncertainty budget must be between 0 and 1.");
    }
    if (args.acceptanceCriteria.length < 1 || args.acceptanceCriteria.length > MAX_ACCEPTANCE_CRITERIA) {
      throw new Error(`Acceptance criteria must contain between 1 and ${MAX_ACCEPTANCE_CRITERIA} items.`);
    }

    const project = await ctx.db
      .query("projects")
      .withIndex("by_owner_and_project_key", (q) => q.eq("ownerId", ownerId).eq("projectKey", projectKey))
      .unique();
    if (!project) throw new Error("Omega mission project does not exist.");

    const acceptanceCriteria = args.acceptanceCriteria.map((criterion) => ({
      criterionId: cleanText(criterion.criterionId, "Criterion ID"),
      statement: cleanText(criterion.statement, "Criterion statement", MAX_STATEMENT_LENGTH),
      status: criterion.status,
      evidenceRefs: uniqueStrings(criterion.evidenceRefs, "Criterion evidence reference"),
    }));
    if (new Set(acceptanceCriteria.map((criterion) => criterion.criterionId)).size !== acceptanceCriteria.length) {
      throw new Error("Acceptance criterion IDs must be unique.");
    }
    if (acceptanceCriteria.some((criterion) => criterion.status !== "unverified" || criterion.evidenceRefs.length !== 0)) {
      throw new Error("New acceptance criteria must start unverified without evidence.");
    }

    const duplicate = await ctx.db
      .query("omegaMissions")
      .withIndex("by_owner_and_mission_id", (q) => q.eq("ownerId", ownerId).eq("missionId", missionId))
      .unique();
    if (duplicate) {
      const same =
        duplicate.projectKey === projectKey &&
        duplicate.objective === objective &&
        duplicate.riskClass === args.riskClass &&
        duplicate.autonomyClass === args.autonomyClass &&
        duplicate.reversibilityClass === args.reversibilityClass &&
        duplicate.uncertaintyBudget === args.uncertaintyBudget &&
        sameJson(duplicate.acceptanceCriteria, acceptanceCriteria);
      if (!same) throw new Error("Omega mission ID already exists with different contents.");
      return duplicate;
    }

    const now = Date.now();
    const id = await ctx.db.insert("omegaMissions", {
      ownerId,
      missionId,
      projectKey,
      objective,
      state: "initializing",
      riskClass: args.riskClass,
      autonomyClass: args.autonomyClass,
      reversibilityClass: args.reversibilityClass,
      uncertaintyBudget: args.uncertaintyBudget,
      acceptanceCriteria,
      policyVersion: POLICY_VERSION,
      createdAt: now,
      updatedAt: now,
    });
    await appendAudit(ctx, {
      ownerId,
      missionId,
      projectKey,
      eventType: "omega.mission.created",
      payload: {
        missionId,
        riskClass: args.riskClass,
        autonomyClass: args.autonomyClass,
        reversibilityClass: args.reversibilityClass,
        acceptanceCriteriaCount: acceptanceCriteria.length,
        policyVersion: POLICY_VERSION,
      },
      createdAt: now,
    });
    const created = await ctx.db.get("omegaMissions", id);
    if (!created) throw new Error("Omega mission creation failed.");
    return created;
  },
});

export const get = query({
  args: { serviceToken: v.string(), missionId: v.string() },
  returns: v.union(omegaMissionDocumentValidator, v.null()),
  handler: async (ctx, args) => {
    const ownerId = requireOwner(args.serviceToken);
    return ctx.db
      .query("omegaMissions")
      .withIndex("by_owner_and_mission_id", (q) => q.eq("ownerId", ownerId).eq("missionId", args.missionId.trim()))
      .unique();
  },
});

export const recordEvidence = mutation({
  args: {
    serviceToken: v.string(),
    missionId: v.string(),
    evidenceId: v.string(),
    claim: v.string(),
    classification: omegaEvidenceClassificationValidator,
    sourceType: omegaEvidenceSourceTypeValidator,
    sourceRef: v.optional(v.string()),
    validUntil: v.optional(v.number()),
    contradicts: v.array(v.string()),
  },
  returns: omegaEvidenceDocumentValidator,
  handler: async (ctx, args) => {
    const ownerId = requireOwner(args.serviceToken);
    const missionId = cleanText(args.missionId, "Mission ID");
    const evidenceId = cleanText(args.evidenceId, "Evidence ID");
    const mission = await requireMission(ctx, ownerId, missionId);
    requireMutableMission(mission.state);
    const claim = cleanText(args.claim, "Evidence claim", MAX_CLAIM_LENGTH);
    const sourceRef = args.sourceRef === undefined ? undefined : cleanText(args.sourceRef, "Evidence source reference", MAX_SOURCE_REF_LENGTH);
    const contradicts = uniqueStrings(args.contradicts, "Contradicting evidence reference");
    if (contradicts.includes(evidenceId)) throw new Error("Evidence cannot contradict itself.");

    const now = Date.now();
    if (args.validUntil !== undefined && (!Number.isFinite(args.validUntil) || args.validUntil <= now)) {
      throw new Error("Evidence validity must end in the future when provided.");
    }
    const existing = await ctx.db
      .query("omegaEvidence")
      .withIndex("by_owner_mission_and_evidence_id", (q) =>
        q.eq("ownerId", ownerId).eq("missionId", missionId).eq("evidenceId", evidenceId),
      )
      .unique();
    if (existing) {
      const same =
        existing.claim === claim &&
        existing.classification === args.classification &&
        existing.sourceType === args.sourceType &&
        existing.sourceRef === sourceRef &&
        existing.validUntil === args.validUntil &&
        sameJson(existing.contradicts, contradicts);
      if (!same) throw new Error("Omega evidence ID already exists with different contents.");
      return existing;
    }
    for (const contradictedId of contradicts) {
      const contradicted = await ctx.db
        .query("omegaEvidence")
        .withIndex("by_owner_mission_and_evidence_id", (q) =>
          q.eq("ownerId", ownerId).eq("missionId", missionId).eq("evidenceId", contradictedId),
        )
        .unique();
      if (!contradicted) throw new Error(`Contradicting evidence reference does not exist: ${contradictedId}.`);
    }
    await assertMissionCapacity(ctx, ownerId, missionId, "omegaEvidence", MAX_EVIDENCE_PER_MISSION, "Omega evidence");

    const id = await ctx.db.insert("omegaEvidence", {
      ownerId,
      missionId,
      evidenceId,
      claim,
      classification: args.classification,
      sourceType: args.sourceType,
      ...(sourceRef === undefined ? {} : { sourceRef }),
      ...(args.validUntil === undefined ? {} : { validUntil: args.validUntil }),
      contradicts,
      createdAt: now,
    });
    await appendAudit(ctx, {
      ownerId,
      missionId,
      projectKey: mission.projectKey,
      eventType: "omega.evidence.recorded",
      payload: { missionId, evidenceId, classification: args.classification, sourceType: args.sourceType },
      createdAt: now,
    });
    const created = await ctx.db.get("omegaEvidence", id);
    if (!created) throw new Error("Omega evidence creation failed.");
    return created;
  },
});

export const recordValidationProof = mutation({
  args: {
    serviceToken: v.string(),
    missionId: v.string(),
    proofId: v.string(),
    criterionId: v.string(),
    method: omegaValidationMethodValidator,
    result: omegaValidationResultValidator,
    independent: v.boolean(),
    evidenceRefs: v.array(v.string()),
    performedBy: v.string(),
  },
  returns: omegaValidationProofDocumentValidator,
  handler: async (ctx, args) => {
    const ownerId = requireOwner(args.serviceToken);
    const missionId = cleanText(args.missionId, "Mission ID");
    const mission = await requireMission(ctx, ownerId, missionId);
    requireMutableMission(mission.state);
    const proofId = cleanText(args.proofId, "Proof ID");
    const criterionId = cleanText(args.criterionId, "Criterion ID");
    const performedBy = cleanText(args.performedBy, "Performed by");
    const criterionIndex = mission.acceptanceCriteria.findIndex((criterion) => criterion.criterionId === criterionId);
    if (criterionIndex < 0) throw new Error("Validation proof references an unknown acceptance criterion.");
    if ((mission.riskClass === "R3" || mission.riskClass === "R4") && args.result === "waived") {
      throw new Error("R3/R4 Omega acceptance criteria cannot be waived.");
    }
    const evidenceRefs = uniqueStrings(args.evidenceRefs, "Validation evidence reference");
    if ((args.result === "pass" || args.result === "waived") && evidenceRefs.length === 0) {
      throw new Error("Passing or waived validation proof requires evidence.");
    }

    const existing = await ctx.db
      .query("omegaValidationProofs")
      .withIndex("by_owner_mission_and_proof_id", (q) =>
        q.eq("ownerId", ownerId).eq("missionId", missionId).eq("proofId", proofId),
      )
      .unique();
    if (existing) {
      const same =
        existing.criterionId === criterionId &&
        existing.method === args.method &&
        existing.result === args.result &&
        existing.independent === args.independent &&
        existing.performedBy === performedBy &&
        sameJson(existing.evidenceRefs, evidenceRefs);
      if (!same) throw new Error("Omega validation proof ID already exists with different contents.");
      return existing;
    }

    const now = Date.now();
    for (const evidenceId of evidenceRefs) {
      const evidence = await ctx.db
        .query("omegaEvidence")
        .withIndex("by_owner_mission_and_evidence_id", (q) =>
          q.eq("ownerId", ownerId).eq("missionId", missionId).eq("evidenceId", evidenceId),
        )
        .unique();
      if (!evidence) throw new Error(`Validation proof references missing evidence: ${evidenceId}.`);
      if (evidence.validUntil !== undefined && evidence.validUntil <= now) {
        throw new Error(`Validation proof references expired evidence: ${evidenceId}.`);
      }
    }
    await assertMissionCapacity(ctx, ownerId, missionId, "omegaValidationProofs", MAX_PROOFS_PER_MISSION, "Omega validation proof");

    const id = await ctx.db.insert("omegaValidationProofs", {
      ownerId,
      missionId,
      proofId,
      criterionId,
      method: args.method,
      result: args.result,
      independent: args.independent,
      evidenceRefs,
      performedBy,
      performedAt: now,
    });
    const nextCriterionStatus =
      args.result === "pass" ? "satisfied" : args.result === "fail" ? "failed" : args.result === "waived" ? "waived" : mission.acceptanceCriteria[criterionIndex].status;
    const acceptanceCriteria = mission.acceptanceCriteria.map((criterion, index) =>
      index === criterionIndex
        ? {
            ...criterion,
            status: nextCriterionStatus,
            evidenceRefs: args.result === "pass" || args.result === "waived" ? evidenceRefs : criterion.evidenceRefs,
          }
        : criterion,
    );
    await ctx.db.patch("omegaMissions", mission._id, { acceptanceCriteria, updatedAt: now });
    await appendAudit(ctx, {
      ownerId,
      missionId,
      projectKey: mission.projectKey,
      eventType: "omega.validation.recorded",
      payload: { missionId, proofId, criterionId, result: args.result, independent: args.independent },
      createdAt: now,
    });
    const created = await ctx.db.get("omegaValidationProofs", id);
    if (!created) throw new Error("Omega validation proof creation failed.");
    return created;
  },
});

export const transition = mutation({
  args: {
    serviceToken: v.string(),
    missionId: v.string(),
    nextState: omegaMissionStateValidator,
    residualUncertainty: v.optional(v.number()),
  },
  returns: omegaMissionDocumentValidator,
  handler: async (ctx, args) => {
    const ownerId = requireOwner(args.serviceToken);
    const missionId = cleanText(args.missionId, "Mission ID");
    const mission = await requireMission(ctx, ownerId, missionId);
    if (!canTransitionOmegaMission(mission.state, args.nextState)) {
      throw new Error(`Invalid Omega mission transition: ${mission.state} -> ${args.nextState}.`);
    }

    const now = Date.now();
    if (args.nextState === "complete") {
      if (args.residualUncertainty === undefined) {
        throw new Error("Completing an Omega mission requires residual uncertainty.");
      }
      const proofs = await ctx.db
        .query("omegaValidationProofs")
        .withIndex("by_owner_and_mission_id", (q) => q.eq("ownerId", ownerId).eq("missionId", missionId))
        .take(MAX_PROOFS_PER_MISSION + 1);
      if (proofs.length > MAX_PROOFS_PER_MISSION) {
        throw new Error("Omega completion requires proof compaction before synchronous validation.");
      }
      const evidence = await ctx.db
        .query("omegaEvidence")
        .withIndex("by_owner_and_mission_id", (q) => q.eq("ownerId", ownerId).eq("missionId", missionId))
        .take(MAX_EVIDENCE_PER_MISSION + 1);
      if (evidence.length > MAX_EVIDENCE_PER_MISSION) {
        throw new Error("Omega completion requires evidence compaction before synchronous validation.");
      }
      const contracts = await ctx.db
        .query("omegaActionContracts")
        .withIndex("by_owner_and_mission_id", (q) => q.eq("ownerId", ownerId).eq("missionId", missionId))
        .take(MAX_CONTRACTS_PER_MISSION + 1);
      if (contracts.length > MAX_CONTRACTS_PER_MISSION) {
        throw new Error("Omega completion requires contract compaction before synchronous validation.");
      }

      const evidenceById = new Map(evidence.map((item) => [item.evidenceId, item]));
      const unresolvedCriticalContradictions = evidence.filter(
        (item) => item.classification === "certain" && item.contradicts.some((evidenceId) => evidenceById.has(evidenceId)),
      ).length;
      const referencedEvidenceIds = new Set<string>();
      for (const criterion of mission.acceptanceCriteria) {
        if (criterion.status === "satisfied" || criterion.status === "waived") {
          for (const evidenceId of criterion.evidenceRefs) referencedEvidenceIds.add(evidenceId);
        }
      }
      for (const proof of proofs) {
        if (proof.result === "pass" || proof.result === "waived") {
          for (const evidenceId of proof.evidenceRefs) referencedEvidenceIds.add(evidenceId);
        }
      }
      let invalidEvidenceRefs = 0;
      for (const evidenceId of referencedEvidenceIds) {
        const item = evidenceById.get(evidenceId);
        if (!item || (item.validUntil !== undefined && item.validUntil <= now)) invalidEvidenceRefs += 1;
      }
      const unresolvedActionContracts = contracts.filter(
        (contract) => !["reconciled", "denied", "expired"].includes(contract.status),
      ).length;
      const completion = evaluateOmegaCompletion({
        criteria: mission.acceptanceCriteria,
        proofs,
        riskClass: mission.riskClass,
        unresolvedCriticalContradictions,
        unresolvedActionContracts,
        invalidEvidenceRefs,
        residualUncertainty: args.residualUncertainty,
        uncertaintyBudget: mission.uncertaintyBudget,
      });
      if (!completion.allowed) {
        throw new Error(`Omega completion denied: ${completion.failures.join(", ")}.`);
      }
    }

    await ctx.db.patch("omegaMissions", mission._id, { state: args.nextState, updatedAt: now });
    await appendAudit(ctx, {
      ownerId,
      missionId,
      projectKey: mission.projectKey,
      eventType: "omega.mission.transitioned",
      payload: { missionId, fromState: mission.state, toState: args.nextState },
      createdAt: now,
    });
    const updated = await ctx.db.get("omegaMissions", mission._id);
    if (!updated) throw new Error("Omega mission transition failed.");
    return updated;
  },
});
