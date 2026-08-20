import { v } from "convex/values";

import { requireApprovalToken, requireOwner } from "./authHelpers.js";
import { omegaContradictionResolutionDocumentValidator } from "./omegaValidators.js";
import { mutation } from "./_generated/server.js";

const MAX_RESOLUTIONS_PER_MISSION = 256;

function cleanText(value: string, label: string): string {
  const cleaned = value.trim();
  if (!cleaned) throw new Error(`${label} cannot be empty.`);
  return cleaned;
}

export const record = mutation({
  args: {
    serviceToken: v.string(),
    approvalToken: v.optional(v.string()),
    missionId: v.string(),
    resolutionId: v.string(),
    contradictionEvidenceId: v.string(),
    contradictedEvidenceId: v.string(),
    reason: v.string(),
    resolvedBy: v.string(),
  },
  returns: omegaContradictionResolutionDocumentValidator,
  handler: async (ctx, args) => {
    const ownerId = requireOwner(args.serviceToken);
    requireApprovalToken(args.approvalToken ?? "");

    const missionId = cleanText(args.missionId, "Mission ID");
    const resolutionId = cleanText(args.resolutionId, "Resolution ID");
    const contradictionEvidenceId = cleanText(
      args.contradictionEvidenceId,
      "Contradicting evidence ID",
    );
    const contradictedEvidenceId = cleanText(
      args.contradictedEvidenceId,
      "Contradicted evidence ID",
    );
    const reason = cleanText(args.reason, "Resolution reason");
    const resolvedBy = cleanText(args.resolvedBy, "Resolved by");

    if (contradictionEvidenceId === contradictedEvidenceId) {
      throw new Error("Contradiction resolution requires two different evidence IDs.");
    }

    const mission = await ctx.db
      .query("omegaMissions")
      .withIndex("by_owner_and_mission_id", (q) =>
        q.eq("ownerId", ownerId).eq("missionId", missionId),
      )
      .unique();
    if (!mission) throw new Error("Omega mission does not exist.");

    const existingById = await ctx.db
      .query("omegaContradictionResolutions")
      .withIndex("by_owner_mission_and_resolution_id", (q) =>
        q.eq("ownerId", ownerId).eq("missionId", missionId).eq("resolutionId", resolutionId),
      )
      .unique();
    if (existingById) {
      if (
        existingById.contradictionEvidenceId !== contradictionEvidenceId ||
        existingById.contradictedEvidenceId !== contradictedEvidenceId ||
        existingById.reason !== reason ||
        existingById.resolvedBy !== resolvedBy ||
        existingById.authority !== "approval-token"
      ) {
        throw new Error("Omega contradiction resolution ID already exists with different contents.");
      }
      return existingById;
    }

    if (mission.state === "complete" || mission.state === "retired") {
      throw new Error("Terminal mission contradiction resolution truth is immutable.");
    }

    const contradictionEvidence = await ctx.db
      .query("omegaEvidence")
      .withIndex("by_owner_mission_and_evidence_id", (q) =>
        q
          .eq("ownerId", ownerId)
          .eq("missionId", missionId)
          .eq("evidenceId", contradictionEvidenceId),
      )
      .unique();
    if (!contradictionEvidence) {
      throw new Error(`Contradicting evidence does not exist: ${contradictionEvidenceId}.`);
    }

    const contradictedEvidence = await ctx.db
      .query("omegaEvidence")
      .withIndex("by_owner_mission_and_evidence_id", (q) =>
        q
          .eq("ownerId", ownerId)
          .eq("missionId", missionId)
          .eq("evidenceId", contradictedEvidenceId),
      )
      .unique();
    if (!contradictedEvidence) {
      throw new Error(`Contradicted evidence does not exist: ${contradictedEvidenceId}.`);
    }

    if (!contradictionEvidence.contradicts.includes(contradictedEvidence.evidenceId)) {
      throw new Error(
        `Evidence ${contradictionEvidenceId} does not contradict ${contradictedEvidenceId}.`,
      );
    }

    const existingEdge = await ctx.db
      .query("omegaContradictionResolutions")
      .withIndex("by_owner_mission_and_contradiction_edge", (q) =>
        q
          .eq("ownerId", ownerId)
          .eq("missionId", missionId)
          .eq("contradictionEvidenceId", contradictionEvidenceId)
          .eq("contradictedEvidenceId", contradictedEvidenceId),
      )
      .unique();
    if (existingEdge) {
      throw new Error(
        `Contradiction edge ${contradictionEvidenceId} -> ${contradictedEvidenceId} is already resolved.`,
      );
    }

    const resolutions = await ctx.db
      .query("omegaContradictionResolutions")
      .withIndex("by_owner_and_mission_id", (q) =>
        q.eq("ownerId", ownerId).eq("missionId", missionId),
      )
      .take(MAX_RESOLUTIONS_PER_MISSION + 1);
    if (resolutions.length >= MAX_RESOLUTIONS_PER_MISSION) {
      throw new Error(
        `Omega mission contradiction resolution limit of ${MAX_RESOLUTIONS_PER_MISSION} reached.`,
      );
    }

    const id = await ctx.db.insert("omegaContradictionResolutions", {
      ownerId,
      missionId,
      resolutionId,
      contradictionEvidenceId,
      contradictedEvidenceId,
      reason,
      resolvedBy,
      authority: "approval-token",
      resolvedAt: Date.now(),
    });

    const created = await ctx.db.get("omegaContradictionResolutions", id);
    if (!created) throw new Error("Omega contradiction resolution creation failed.");
    return created;
  },
});
