import { v } from "convex/values";

import { requireApprovalToken, requireOwner } from "./authHelpers.js";
import { omegaMissionDocumentValidator } from "./omegaValidators.js";
import { cleanRequiredText, normaliseAuditPayload } from "./toolActionLogic.js";
import { mutation } from "./_generated/server.js";

export const unblock = mutation({
  args: {
    serviceToken: v.string(),
    approvalToken: v.string(),
    missionId: v.string(),
    reason: v.string(),
  },
  returns: omegaMissionDocumentValidator,
  handler: async (ctx, args) => {
    const ownerId = requireOwner(args.serviceToken);
    requireApprovalToken(args.approvalToken);
    const missionId = cleanRequiredText(args.missionId, "Mission ID");
    const reason = cleanRequiredText(args.reason, "Mission unblock reason");

    const mission = await ctx.db
      .query("omegaMissions")
      .withIndex("by_owner_and_mission_id", (q) =>
        q.eq("ownerId", ownerId).eq("missionId", missionId),
      )
      .unique();
    if (!mission) throw new Error("Omega mission does not exist.");
    if (mission.state !== "blocked") {
      throw new Error(`Omega mission is ${mission.state}; only blocked missions can be unblocked.`);
    }

    const now = Date.now();
    await ctx.db.patch("omegaMissions", mission._id, {
      state: "active",
      updatedAt: now,
    });
    await ctx.db.insert("auditEvents", {
      ownerId,
      requestId: `omega-unblock:${missionId}`,
      scopeKey: mission.projectKey,
      eventType: "omega.mission.unblocked",
      actor: "user",
      payload: normaliseAuditPayload({
        missionId,
        reason,
        previousState: "blocked",
        nextState: "active",
      }),
      createdAt: now,
    });

    const updated = await ctx.db.get("omegaMissions", mission._id);
    if (!updated) throw new Error("Omega mission unblock failed.");
    return updated;
  },
});
