import { v } from "convex/values";

import { requireOwner } from "./authHelpers.js";
import { validationCheckValidator } from "./totalityValidators.js";
import { mutation } from "./_generated/server.js";

const GLOBAL_SCOPE = "__global__";

function scopeKey(projectKey: string | undefined): string {
  const cleaned = projectKey?.trim();
  return cleaned && cleaned.length > 0 ? cleaned : GLOBAL_SCOPE;
}

export const commit = mutation({
  args: {
    serviceToken: v.string(),
    requestId: v.string(),
    projectKey: v.optional(v.string()),
    report: v.object({
      passed: v.boolean(),
      checks: v.array(validationCheckValidator),
      warnings: v.array(v.string()),
      blockingFailures: v.array(v.string()),
    }),
    event: v.object({
      eventType: v.string(),
      actor: v.literal("agent"),
      payload: v.record(v.string(), v.any()),
    }),
  },
  returns: v.object({
    validationReportId: v.id("validationReports"),
    auditEventId: v.id("auditEvents"),
  }),
  handler: async (ctx, args) => {
    const ownerId = requireOwner(args.serviceToken);
    const requestId = args.requestId.trim();
    if (requestId.length === 0) throw new Error("Request ID cannot be empty.");
    const eventType = args.event.eventType.trim();
    if (eventType.length === 0) throw new Error("Audit event type cannot be empty.");
    const resolvedScope = scopeKey(args.projectKey);
    const createdAt = Date.now();

    const existingReport = await ctx.db
      .query("validationReports")
      .withIndex("by_owner_and_request_id", (q) =>
        q.eq("ownerId", ownerId).eq("requestId", requestId),
      )
      .unique();

    const reportValues = {
      ownerId,
      requestId,
      scopeKey: resolvedScope,
      passed: args.report.passed,
      checks: args.report.checks,
      warnings: args.report.warnings,
      blockingFailures: args.report.blockingFailures,
      createdAt,
    };
    let validationReportId;
    if (existingReport) {
      await ctx.db.patch("validationReports", existingReport._id, reportValues);
      validationReportId = existingReport._id;
    } else {
      validationReportId = await ctx.db.insert("validationReports", reportValues);
    }

    const auditEventId = await ctx.db.insert("auditEvents", {
      ownerId,
      requestId,
      scopeKey: resolvedScope,
      eventType,
      actor: args.event.actor,
      payload: args.event.payload,
      createdAt,
    });

    return { validationReportId, auditEventId };
  },
});
