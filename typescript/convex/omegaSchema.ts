import { defineTable } from "convex/server";
import { v } from "convex/values";

import {
  omegaAcceptanceCriterionValidator,
  omegaActionContractStateValidator,
  omegaAutonomyClassValidator,
  omegaEvidenceClassificationValidator,
  omegaEvidenceSourceTypeValidator,
  omegaMissionStateValidator,
  omegaReversibilityClassValidator,
  omegaRiskClassValidator,
  omegaValidationMethodValidator,
  omegaValidationResultValidator,
} from "./omegaValidators.js";

export const omegaTables = {
  omegaMissions: defineTable({
    ownerId: v.string(),
    missionId: v.string(),
    projectKey: v.string(),
    objective: v.string(),
    state: omegaMissionStateValidator,
    riskClass: omegaRiskClassValidator,
    autonomyClass: omegaAutonomyClassValidator,
    reversibilityClass: omegaReversibilityClassValidator,
    uncertaintyBudget: v.number(),
    acceptanceCriteria: v.array(omegaAcceptanceCriterionValidator),
    policyVersion: v.string(),
    createdAt: v.number(),
    updatedAt: v.number(),
  })
    .index("by_owner_and_mission_id", ["ownerId", "missionId"])
    .index("by_owner_project_and_state", ["ownerId", "projectKey", "state"]),
  omegaEvidence: defineTable({
    ownerId: v.string(),
    missionId: v.string(),
    evidenceId: v.string(),
    claim: v.string(),
    classification: omegaEvidenceClassificationValidator,
    sourceType: omegaEvidenceSourceTypeValidator,
    sourceRef: v.optional(v.string()),
    validUntil: v.optional(v.number()),
    contradicts: v.array(v.string()),
    createdAt: v.number(),
  })
    .index("by_owner_and_mission_id", ["ownerId", "missionId"])
    .index("by_owner_mission_and_evidence_id", ["ownerId", "missionId", "evidenceId"]),
  omegaActionContracts: defineTable({
    ownerId: v.string(),
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
    approvalRef: v.optional(v.string()),
    authorityExpiresAt: v.optional(v.number()),
    status: omegaActionContractStateValidator,
    createdAt: v.number(),
    updatedAt: v.number(),
  })
    .index("by_owner_and_mission_id", ["ownerId", "missionId"])
    .index("by_owner_mission_and_contract_id", ["ownerId", "missionId", "contractId"])
    .index("by_owner_and_tool_action_id", ["ownerId", "toolActionId"]),
  omegaValidationProofs: defineTable({
    ownerId: v.string(),
    missionId: v.string(),
    proofId: v.string(),
    criterionId: v.string(),
    method: omegaValidationMethodValidator,
    result: omegaValidationResultValidator,
    independent: v.boolean(),
    evidenceRefs: v.array(v.string()),
    performedBy: v.string(),
    performedAt: v.number(),
  })
    .index("by_owner_and_mission_id", ["ownerId", "missionId"])
    .index("by_owner_mission_and_proof_id", ["ownerId", "missionId", "proofId"]),
};
