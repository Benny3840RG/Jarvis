import { v } from "convex/values";

import { requireOwner } from "./authHelpers.js";
import {
  assertUniqueMeasurementKeys,
  cleanRequiredText,
  normalizeMemoryRecords,
  requirePositiveRevision,
  sameMemoryProposal,
} from "./memoryChangeSetLogic.js";
import { memoryRecordValidator } from "./memoryChangeSetValidators.js";
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
    memoryProposal: v.optional(
      v.object({
        changeSetId: v.string(),
        expectedRevision: v.number(),
        records: v.array(memoryRecordValidator),
        rationale: v.string(),
      }),
    ),
  },
  returns: v.object({
    validationReportId: v.id("validationReports"),
    auditEventId: v.id("auditEvents"),
    memoryChangeSetId: v.union(v.string(), v.null()),
  }),
  handler: async (ctx, args) => {
    const ownerId = requireOwner(args.serviceToken);
    const requestId = cleanRequiredText(args.requestId, "Request ID");
    const eventType = cleanRequiredText(args.event.eventType, "Audit event type");
    const resolvedScope = scopeKey(args.projectKey);
    const createdAt = Date.now();
    let memoryChangeSetId: string | null = null;

    if (args.memoryProposal !== undefined) {
      if (!args.report.passed) {
        throw new Error("Blocked reasoning cannot stage a memory change set.");
      }
      if (resolvedScope === GLOBAL_SCOPE) {
        throw new Error("Reasoning memory proposals require a project scope.");
      }

      const changeSetId = cleanRequiredText(
        args.memoryProposal.changeSetId,
        "Memory change set ID",
      );
      const expectedRevision = requirePositiveRevision(
        args.memoryProposal.expectedRevision,
        "Expected revision",
      );
      const records = normalizeMemoryRecords(args.memoryProposal.records);
      assertUniqueMeasurementKeys(records);
      const rationale = cleanRequiredText(
        args.memoryProposal.rationale,
        "Memory change set rationale",
      );

      const existingChangeSet = await ctx.db
        .query("memoryChangeSets")
        .withIndex("by_owner_and_change_set_id", (q) =>
          q.eq("ownerId", ownerId).eq("changeSetId", changeSetId),
        )
        .unique();
      if (existingChangeSet) {
        if (
          !sameMemoryProposal(existingChangeSet, {
            projectKey: resolvedScope,
            baseRevision: expectedRevision,
            records,
            rationale,
            proposedBy: "agent",
          })
        ) {
          throw new Error("Memory change set ID already exists with different contents.");
        }
        memoryChangeSetId = existingChangeSet.changeSetId;
      } else {
        const project = await ctx.db
          .query("projects")
          .withIndex("by_owner_and_project_key", (q) =>
            q.eq("ownerId", ownerId).eq("projectKey", resolvedScope),
          )
          .unique();
        if (!project) throw new Error("Memory change set project does not exist.");
        if (project.revision !== expectedRevision) {
          throw new Error(
            `Project revision conflict: expected ${expectedRevision}, current ${project.revision}.`,
          );
        }

        await ctx.db.insert("memoryChangeSets", {
          ownerId,
          changeSetId,
          requestId,
          projectKey: resolvedScope,
          baseRevision: expectedRevision,
          state: "proposed",
          records,
          rationale,
          proposedBy: "agent",
          createdAt,
          updatedAt: createdAt,
        });
        await ctx.db.insert("auditEvents", {
          ownerId,
          requestId,
          scopeKey: resolvedScope,
          eventType: "memory.change_set.proposed",
          actor: "agent",
          payload: {
            changeSetId,
            baseRevision: expectedRevision,
            recordCount: records.length,
            recordIds: records.map((record) => record.recordId),
          },
          createdAt,
        });
        memoryChangeSetId = changeSetId;
      }
    }

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

    return { validationReportId, auditEventId, memoryChangeSetId };
  },
});
