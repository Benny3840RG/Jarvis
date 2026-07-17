import { v } from "convex/values";

import { projectRecordDocumentValidator, projectValidator } from "./totalityValidators.js";

const impactValidator = v.union(v.literal("low"), v.literal("medium"), v.literal("high"));

export const memoryFactValidator = v.object({
  kind: v.literal("fact"),
  recordId: v.string(),
  statement: v.string(),
  source: v.union(
    v.literal("user"),
    v.literal("file"),
    v.literal("tool"),
    v.literal("measurement"),
    v.literal("inference"),
  ),
  confidence: v.number(),
  recordedAt: v.string(),
});

export const memoryAssumptionValidator = v.object({
  kind: v.literal("assumption"),
  recordId: v.string(),
  statement: v.string(),
  status: v.union(v.literal("unverified"), v.literal("verified"), v.literal("rejected")),
  impact: impactValidator,
});

export const memoryMeasurementValidator = v.object({
  kind: v.literal("measurement"),
  recordId: v.string(),
  name: v.string(),
  value: v.number(),
  unit: v.string(),
  tolerance: v.optional(v.string()),
  source: v.string(),
});

export const memoryDecisionValidator = v.object({
  kind: v.literal("decision"),
  recordId: v.string(),
  decision: v.string(),
  rationale: v.string(),
  alternativesRejected: v.array(v.string()),
  timestamp: v.string(),
});

export const memoryRecordValidator = v.union(
  memoryFactValidator,
  memoryAssumptionValidator,
  memoryMeasurementValidator,
  memoryDecisionValidator,
);

export const memoryChangeSetStateValidator = v.union(
  v.literal("proposed"),
  v.literal("approved"),
  v.literal("rejected"),
  v.literal("applied"),
);

export const memoryChangeSetActorValidator = v.union(
  v.literal("user"),
  v.literal("agent"),
  v.literal("tool"),
);

export const memoryChangeSetDocumentValidator = v.object({
  _id: v.id("memoryChangeSets"),
  _creationTime: v.number(),
  ownerId: v.string(),
  changeSetId: v.string(),
  requestId: v.string(),
  projectKey: v.string(),
  baseRevision: v.number(),
  state: memoryChangeSetStateValidator,
  records: v.array(memoryRecordValidator),
  rationale: v.string(),
  proposedBy: memoryChangeSetActorValidator,
  approvedBy: v.optional(v.literal("user")),
  rejectedBy: v.optional(v.literal("user")),
  rejectedReason: v.optional(v.string()),
  createdAt: v.number(),
  updatedAt: v.number(),
  approvedAt: v.optional(v.number()),
  rejectedAt: v.optional(v.number()),
  appliedAt: v.optional(v.number()),
  appliedRevision: v.optional(v.number()),
});

export const memoryApplyResultValidator = v.object({
  changeSet: memoryChangeSetDocumentValidator,
  project: projectValidator,
  records: v.array(projectRecordDocumentValidator),
  idempotent: v.boolean(),
});
