import { v } from "convex/values";

import { evaluateOmegaCompletion, canTransitionOmegaMission } from "../src/omega/policy.js";
import { projectOmegaDevelopmentCompletion } from "./developmentState.js";
import { requireApprovalToken, requireOwner } from "./authHelpers.js";
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

const POLICY_VERSION = "omega-sigma:v1";
const MAX_ACCEPTANCE_CRITERIA = 64;
const MAX_EVIDENCE_PER_MISSION = 256;
const MAX_PROOFS_PER_MISSION = 256;
const MAX_CONTRACTS_PER_MISSION = 128;
const MAX_RESOLUTIONS_PER_MISSION = 256;
const MAX_REFERENCES_PER_ITEM = 32;

function cleanText(value: string, label: string): string {
  const cleaned = value.trim();
  if (!cleaned) throw new Error(`${label} cannot be empty.`);
  return cleaned;
}

function sameStrings(left: readonly string[], right: readonly string[]): boolean {
  return left.length === right.length && left.every((value, index) => value === right[index]);
}

function uniqueStrings(values: readonly string[], label: string): string[] {
  if (values.length > MAX_REFERENCES_PER_ITEM) {
    throw new Error(`${label} cannot contain more than ${MAX_REFERENCES_PER_ITEM} values.`);
  }
  const cleaned = values.map((value) => cleanText(value, label));
  if (new Set(cleaned).size !== cleaned.length) {
    throw new Error(`${label} values must be unique.`);
  }
  return cleaned;
}

function mergeUniqueStrings(
  existing: readonly string[],
  incoming: readonly string[],
  label: string,
): string[] {
  const merged = [...existing];
  for (const value of incoming) {
    if (!merged.includes(value)) merged.push(value);
  }
  if (merged.length > MAX_REFERENCES_PER_ITEM) {
    throw new Error(`${label} cannot contain more than ${MAX_REFERENCES_PER_ITEM} values.`);
  }
  return merged;
}

async function requireMission(ctx: MutationCtx, ownerId: string, missionId: string) {
  const mission = await ctx.db
    .query("omegaMissions")
    .withIndex("by_owner_and_mission_id", (q) =>
      q.eq("ownerId", ownerId).eq("missionId", missionId),
    )
    .unique();
  if (!mission) throw new Error("Omega mission does not exist.");
  return mission;
}

function requireMutableMissionTruth(mission: { state: string }): void {
  if (mission.state === "complete") {
    throw new Error("Completed mission evidence and validation truth is immutable.");
  }
  if (mission.state === "retired") {
    throw new Error("Terminal mission evidence and validation truth is immutable.");
  }
}

async function enforceMissionRowLimit(
  ctx: MutationCtx,
  table: "omegaEvidence" | "omegaValidationProofs",
  ownerId: string,
  missionId: string,
  limit: number,
  label: string,
): Promise<void> {
  const rows = await ctx.db
    .query(table)
    .withIndex("by_owner_and_mission_id", (q) =>
      q.eq("ownerId", ownerId).eq("missionId", missionId),
    )
    .take(limit + 1);
  if (rows.length >= limit) {
    throw new Error(`Omega mission ${label} limit of ${limit} reached.`);
  }
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
    const objective = cleanText(args.objective, "Objective");

    if (
      !Number.isFinite(args.uncertaintyBudget) ||
      args.uncertaintyBudget < 0 ||
      args.uncertaintyBudget > 1
    ) {
      throw new Error("Uncertainty budget must be between 0 and 1.");
    }
    if (args.acceptanceCriteria.length === 0) {
      throw new Error("At least one acceptance criterion is required.");
    }
    if (args.acceptanceCriteria.length > MAX_ACCEPTANCE_CRITERIA) {
      throw new Error(`At most ${MAX_ACCEPTANCE_CRITERIA} acceptance criteria are supported.`);
    }

    const acceptanceCriteria = args.acceptanceCriteria.map((criterion) => ({
      criterionId: cleanText(criterion.criterionId, "Criterion ID"),
      statement: cleanText(criterion.statement, "Criterion statement"),
      status: criterion.status,
      evidenceRefs: uniqueStrings(criterion.evidenceRefs, "Criterion evidence reference"),
    }));
    if (
      new Set(acceptanceCriteria.map((criterion) => criterion.criterionId)).size !==
      acceptanceCriteria.length
    ) {
      throw new Error("Acceptance criterion IDs must be unique.");
    }
    if (
      acceptanceCriteria.some(
        (criterion) => criterion.status !== "unverified" || criterion.evidenceRefs.length !== 0,
      )
    ) {
      throw new Error("New acceptance criteria must start unverified without evidence.");
    }

    const duplicate = await ctx.db
      .query("omegaMissions")
      .withIndex("by_owner_and_mission_id", (q) =>
        q.eq("ownerId", ownerId).eq("missionId", missionId),
      )
      .unique();
    if (duplicate) {
      const sameCriteria =
        duplicate.acceptanceCriteria.length === acceptanceCriteria.length &&
        duplicate.acceptanceCriteria.every((criterion, index) => {
          const proposed = acceptanceCriteria[index];
          return (
            criterion.criterionId === proposed.criterionId &&
            criterion.statement === proposed.statement &&
            criterion.status === proposed.status &&
            sameStrings(criterion.evidenceRefs, proposed.evidenceRefs)
          );
        });
      if (
        duplicate.projectKey !== projectKey ||
        duplicate.objective !== objective ||
        duplicate.riskClass !== args.riskClass ||
        duplicate.autonomyClass !== args.autonomyClass ||
        duplicate.reversibilityClass !== args.reversibilityClass ||
        duplicate.uncertaintyBudget !== args.uncertaintyBudget ||
        !sameCriteria
      ) {
        throw new Error("Omega mission ID already exists with different contents.");
      }
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
      .withIndex("by_owner_and_mission_id", (q) =>
        q.eq("ownerId", ownerId).eq("missionId", args.missionId.trim()),
      )
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

    const claim = cleanText(args.claim, "Evidence claim");
    const sourceRef =
      args.sourceRef === undefined ? undefined : cleanText(args.sourceRef, "Source reference");
    const contradicts = uniqueStrings(args.contradicts, "Contradicting evidence reference");
    if (contradicts.includes(evidenceId)) {
      throw new Error("Evidence cannot contradict itself.");
    }
    const now = Date.now();
    if (
      args.validUntil !== undefined &&
      (!Number.isFinite(args.validUntil) || args.validUntil <= now)
    ) {
      throw new Error("Evidence validity must end in the future.");
    }

    const existing = await ctx.db
      .query("omegaEvidence")
      .withIndex("by_owner_mission_and_evidence_id", (q) =>
        q.eq("ownerId", ownerId).eq("missionId", missionId).eq("evidenceId", evidenceId),
      )
      .unique();
    if (existing) {
      if (
        existing.claim !== claim ||
        existing.classification !== args.classification ||
        existing.sourceType !== args.sourceType ||
        existing.sourceRef !== sourceRef ||
        existing.validUntil !== args.validUntil ||
        !sameStrings(existing.contradicts, contradicts)
      ) {
        throw new Error("Omega evidence ID already exists with different contents.");
      }
      return existing;
    }

    requireMutableMissionTruth(mission);

    for (const contradictedEvidenceId of contradicts) {
      const contradicted = await ctx.db
        .query("omegaEvidence")
        .withIndex("by_owner_mission_and_evidence_id", (q) =>
          q
            .eq("ownerId", ownerId)
            .eq("missionId", missionId)
            .eq("evidenceId", contradictedEvidenceId),
        )
        .unique();
      if (!contradicted) {
        throw new Error(`Contradicting evidence does not exist: ${contradictedEvidenceId}.`);
      }
    }

    await enforceMissionRowLimit(
      ctx,
      "omegaEvidence",
      ownerId,
      missionId,
      MAX_EVIDENCE_PER_MISSION,
      "evidence",
    );

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
    const created = await ctx.db.get("omegaEvidence", id);
    if (!created) throw new Error("Omega evidence creation failed.");
    return created;
  },
});

export const recordValidationProof = mutation({
  args: {
    serviceToken: v.string(),
    approvalToken: v.optional(v.string()),
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
    if (args.independent) requireApprovalToken(args.approvalToken ?? "");
    const missionId = cleanText(args.missionId, "Mission ID");
    const mission = await requireMission(ctx, ownerId, missionId);

    const proofId = cleanText(args.proofId, "Proof ID");
    const criterionId = cleanText(args.criterionId, "Criterion ID");
    const performedBy = cleanText(args.performedBy, "Performed by");
    const criterionIndex = mission.acceptanceCriteria.findIndex(
      (criterion) => criterion.criterionId === criterionId,
    );
    if (criterionIndex < 0) {
      throw new Error("Validation proof references an unknown acceptance criterion.");
    }

    const evidenceRefs = uniqueStrings(args.evidenceRefs, "Validation evidence reference");
    if (args.result === "pass" && evidenceRefs.length === 0) {
      throw new Error("Passing validation proof requires evidence.");
    }

    const existing = await ctx.db
      .query("omegaValidationProofs")
      .withIndex("by_owner_mission_and_proof_id", (q) =>
        q.eq("ownerId", ownerId).eq("missionId", missionId).eq("proofId", proofId),
      )
      .unique();
    if (existing) {
      if (
        existing.criterionId !== criterionId ||
        existing.method !== args.method ||
        existing.result !== args.result ||
        existing.independent !== args.independent ||
        existing.performedBy !== performedBy ||
        !sameStrings(existing.evidenceRefs, evidenceRefs)
      ) {
        throw new Error("Omega validation proof ID already exists with different contents.");
      }
      return existing;
    }

    requireMutableMissionTruth(mission);

    const now = Date.now();
    for (const evidenceId of evidenceRefs) {
      const evidence = await ctx.db
        .query("omegaEvidence")
        .withIndex("by_owner_mission_and_evidence_id", (q) =>
          q.eq("ownerId", ownerId).eq("missionId", missionId).eq("evidenceId", evidenceId),
        )
        .unique();
      if (!evidence) {
        throw new Error(`Validation proof references missing evidence: ${evidenceId}.`);
      }
      if (evidence.validUntil !== undefined && evidence.validUntil <= now) {
        throw new Error(`Validation proof references expired evidence: ${evidenceId}.`);
      }
    }

    await enforceMissionRowLimit(
      ctx,
      "omegaValidationProofs",
      ownerId,
      missionId,
      MAX_PROOFS_PER_MISSION,
      "validation proof",
    );

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
      args.result === "pass"
        ? "satisfied"
        : args.result === "fail"
          ? "failed"
          : args.result === "waived"
            ? "waived"
            : mission.acceptanceCriteria[criterionIndex].status;

    const acceptanceCriteria = mission.acceptanceCriteria.map((criterion, index) =>
      index === criterionIndex
        ? {
            ...criterion,
            status: nextCriterionStatus,
            evidenceRefs:
              args.result === "pass" || args.result === "waived"
                ? mergeUniqueStrings(
                    criterion.evidenceRefs,
                    evidenceRefs,
                    "Criterion evidence reference",
                  )
                : criterion.evidenceRefs,
          }
        : criterion,
    );
    await ctx.db.patch("omegaMissions", mission._id, {
      acceptanceCriteria,
      updatedAt: now,
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
    /**
     * Unlike every other completion input below (criteria, proofs,
     * contradictions, external effects — all derived from durable rows),
     * this is the caller's own judgment and is bounded ([0,1], <=
     * uncertaintyBudget) but not independently re-derived: there is no
     * mechanical row to check it against. It can only ever be reached
     * after every other, fully row-derived completion check has already
     * passed (evaluateOmegaCompletion requires a passing proof per
     * criterion, no unresolved contradictions, no unreconciled external
     * effects), so it narrows an already-evidenced completion rather than
     * substituting for evidence. Since this mutation now also atomically
     * projects a bound Development subject to COMPLETE
     * (projectOmegaDevelopmentCompletion below), a wrong value here has a
     * wider blast radius than before that projection existed -- flagged
     * here rather than silently accepted.
     */
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
        .withIndex("by_owner_and_mission_id", (q) =>
          q.eq("ownerId", ownerId).eq("missionId", missionId),
        )
        .take(MAX_PROOFS_PER_MISSION + 1);
      if (proofs.length > MAX_PROOFS_PER_MISSION) {
        throw new Error("Omega mission validation proof set exceeds its bounded policy limit.");
      }

      const evidence = await ctx.db
        .query("omegaEvidence")
        .withIndex("by_owner_and_mission_id", (q) =>
          q.eq("ownerId", ownerId).eq("missionId", missionId),
        )
        .take(MAX_EVIDENCE_PER_MISSION + 1);
      if (evidence.length > MAX_EVIDENCE_PER_MISSION) {
        throw new Error("Omega mission evidence set exceeds its bounded policy limit.");
      }

      const contracts = await ctx.db
        .query("omegaActionContracts")
        .withIndex("by_owner_and_mission_id", (q) =>
          q.eq("ownerId", ownerId).eq("missionId", missionId),
        )
        .take(MAX_CONTRACTS_PER_MISSION + 1);
      if (contracts.length > MAX_CONTRACTS_PER_MISSION) {
        throw new Error("Omega mission contract set exceeds its bounded policy limit.");
      }

      const contradictionResolutions = await ctx.db
        .query("omegaContradictionResolutions")
        .withIndex("by_owner_and_mission_id", (q) =>
          q.eq("ownerId", ownerId).eq("missionId", missionId),
        )
        .take(MAX_RESOLUTIONS_PER_MISSION + 1);
      if (contradictionResolutions.length > MAX_RESOLUTIONS_PER_MISSION) {
        throw new Error(
          "Omega mission contradiction resolution set exceeds its bounded policy limit.",
        );
      }

      const currentEvidenceIds = new Set(
        evidence
          .filter((item) => item.validUntil === undefined || item.validUntil > now)
          .map((item) => item.evidenceId),
      );
      const criteriaForCompletion = mission.acceptanceCriteria.map((criterion) => ({
        criterionId: criterion.criterionId,
      }));
      const currentProofs = proofs
        .filter(
          (proof) =>
            proof.evidenceRefs.length > 0 &&
            proof.evidenceRefs.every((evidenceId) => currentEvidenceIds.has(evidenceId)),
        )
        .map((proof) => ({
          criterionId: proof.criterionId,
          result: proof.result,
          independent: proof.independent,
          evidenceRefs: proof.evidenceRefs,
        }));

      const resolvedContradictionTargets = new Map<string, Set<string>>();
      for (const resolution of contradictionResolutions) {
        const resolvedTargets =
          resolvedContradictionTargets.get(resolution.contradictionEvidenceId) ?? new Set<string>();
        resolvedTargets.add(resolution.contradictedEvidenceId);
        resolvedContradictionTargets.set(resolution.contradictionEvidenceId, resolvedTargets);
      }

      let unresolvedCriticalContradictions = 0;
      for (const item of evidence) {
        if (
          (item.validUntil === undefined || item.validUntil > now) &&
          item.classification === "certain"
        ) {
          const resolvedTargets = resolvedContradictionTargets.get(item.evidenceId);
          for (const contradictedEvidenceId of item.contradicts) {
            if (!resolvedTargets?.has(contradictedEvidenceId)) {
              unresolvedCriticalContradictions += 1;
            }
          }
        }
      }

      const unreconciledExternalEffects = contracts.filter(
        (contract) => !["reconciled", "denied", "expired", "rolled-back"].includes(contract.status),
      ).length;

      const completion = evaluateOmegaCompletion({
        criteria: criteriaForCompletion,
        proofs: currentProofs,
        riskClass: mission.riskClass,
        unresolvedCriticalContradictions,
        unreconciledExternalEffects,
        residualUncertainty: args.residualUncertainty,
        uncertaintyBudget: mission.uncertaintyBudget,
      });

      if (!completion.allowed) {
        throw new Error(`Omega completion denied: ${completion.failures.join(", ")}.`);
      }

      await projectOmegaDevelopmentCompletion(ctx, {
        ownerId,
        missionId,
        evidenceIds: [
          ...new Set(
            currentProofs
              .filter((proof) => proof.result === "pass")
              .flatMap((proof) => proof.evidenceRefs),
          ),
        ],
        completionInput: {
          criteria: criteriaForCompletion,
          proofs: currentProofs,
          riskClass: mission.riskClass,
          unresolvedCriticalContradictions,
          unreconciledExternalEffects,
          residualUncertainty: args.residualUncertainty,
          uncertaintyBudget: mission.uncertaintyBudget,
        },
        now,
      });
    }

    await ctx.db.patch("omegaMissions", mission._id, {
      state: args.nextState,
      updatedAt: now,
    });
    const updated = await ctx.db.get("omegaMissions", mission._id);
    if (!updated) throw new Error("Omega mission transition failed.");
    return updated;
  },
});
