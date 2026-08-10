import { v } from "convex/values";

import { toolAuthorityValidator } from "./toolActionValidators.js";

export const omegaMissionStateValidator = v.union(
  v.literal("dormant"),
  v.literal("initializing"),
  v.literal("active"),
  v.literal("validating"),
  v.literal("degraded"),
  v.literal("recovering"),
  v.literal("blocked"),
  v.literal("partial"),
  v.literal("complete"),
  v.literal("aborted"),
  v.literal("retired"),
);

export const omegaRiskClassValidator = v.union(
  v.literal("R0"),
  v.literal("R1"),
  v.literal("R2"),
  v.literal("R3"),
  v.literal("R4"),
);

export const omegaAutonomyClassValidator = v.union(
  v.literal("A0"),
  v.literal("A1"),
  v.literal("A2"),
  v.literal("A3"),
  v.literal("A4"),
  v.literal("A5"),
  v.literal("A6"),
);

export const omegaReversibilityClassValidator = v.union(
  v.literal("REV-0"),
  v.literal("REV-1"),
  v.literal("REV-2"),
  v.literal("REV-3"),
  v.literal("REV-4"),
  v.literal("REV-5"),
);

export const omegaCriterionStatusValidator = v.union(
  v.literal("unverified"),
  v.literal("satisfied"),
  v.literal("failed"),
  v.literal("waived"),
);

export const omegaAcceptanceCriterionValidator = v.object({
  criterionId: v.string(),
  statement: v.string(),
  status: omegaCriterionStatusValidator,
  evidenceRefs: v.array(v.string()),
});

export const omegaEvidenceClassificationValidator = v.union(
  v.literal("certain"),
  v.literal("high-confidence"),
  v.literal("probable"),
  v.literal("possible"),
  v.literal("unknown"),
);

export const omegaEvidenceSourceTypeValidator = v.union(
  v.literal("direct-measurement"),
  v.literal("independent-verification"),
  v.literal("primary-source"),
  v.literal("corroborated-source"),
  v.literal("inference"),
  v.literal("assumption"),
  v.literal("speculation"),
);

export const omegaValidationMethodValidator = v.union(
  v.literal("static"),
  v.literal("build"),
  v.literal("unit"),
  v.literal("integration"),
  v.literal("boundary"),
  v.literal("security"),
  v.literal("performance"),
  v.literal("operational"),
  v.literal("independent"),
  v.literal("clean-state"),
  v.literal("human-review"),
  v.literal("measurement"),
);

export const omegaValidationResultValidator = v.union(
  v.literal("pass"),
  v.literal("fail"),
  v.literal("inconclusive"),
  v.literal("waived"),
);

export const omegaActionContractStateValidator = v.union(
  v.literal("proposed"),
  v.literal("authorized"),
  v.literal("claimed"),
  v.literal("indeterminate"),
  v.literal("reconciled"),
  v.literal("denied"),
  v.literal("expired"),
  v.literal("conflicted"),
);

export const omegaTerminalOutcomeValidator = v.union(v.literal("succeeded"), v.literal("failed"));

export const omegaMissionDocumentValidator = v.object({
  _id: v.id("omegaMissions"),
  _creationTime: v.number(),
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
});

export const omegaEvidenceDocumentValidator = v.object({
  _id: v.id("omegaEvidence"),
  _creationTime: v.number(),
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
});

export const omegaActionContractDocumentValidator = v.object({
  _id: v.id("omegaActionContracts"),
  _creationTime: v.number(),
  ownerId: v.string(),
  missionId: v.string(),
  contractId: v.string(),
  toolActionId: v.string(),
  intent: v.string(),
  riskClass: omegaRiskClassValidator,
  reversibilityClass: omegaReversibilityClassValidator,
  requiredAuthority: toolAuthorityValidator,
  scope: v.record(v.string(), v.any()),
  preconditionEvidenceRefs: v.array(v.string()),
  rollbackPlan: v.optional(v.string()),
  approvalRef: v.optional(v.string()),
  authorityExpiresAt: v.optional(v.number()),
  executionClaimId: v.optional(v.string()),
  denialReason: v.optional(v.string()),
  terminalOutcome: v.optional(omegaTerminalOutcomeValidator),
  reconciledReceiptKey: v.optional(v.string()),
  reconciledAt: v.optional(v.number()),
  status: omegaActionContractStateValidator,
  createdAt: v.number(),
  updatedAt: v.number(),
});

export const omegaValidationProofDocumentValidator = v.object({
  _id: v.id("omegaValidationProofs"),
  _creationTime: v.number(),
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
});
