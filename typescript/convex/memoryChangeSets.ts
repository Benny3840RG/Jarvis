import { v } from "convex/values";

import { requireOwner } from "./authHelpers.js";
import {
  MAX_PROJECT_MEASUREMENTS,
  assertUniqueMeasurementKeys,
  cleanRequiredText,
  measurementKey,
  normalizeMemoryRecords,
  requirePositiveRevision,
  type MemoryRecord,
} from "./memoryChangeSetLogic.js";
import {
  memoryApplyResultValidator,
  memoryChangeSetActorValidator,
  memoryChangeSetDocumentValidator,
  memoryChangeSetStateValidator,
  memoryRecordValidator,
} from "./memoryChangeSetValidators.js";
import { mutation, query, type MutationCtx, type QueryCtx } from "./_generated/server.js";
import type { Doc } from "./_generated/dataModel.js";

const MAX_LIST_LIMIT = 100;
const DEFAULT_LIST_LIMIT = 25;

type ReadCtx = QueryCtx | MutationCtx;

function boundedLimit(limit: number | undefined): number {
  const resolved = limit ?? DEFAULT_LIST_LIMIT;
  if (!Number.isInteger(resolved) || resolved < 1 || resolved > MAX_LIST_LIMIT) {
    throw new Error(`Limit must be an integer between 1 and ${MAX_LIST_LIMIT}.`);
  }
  return resolved;
}

async function requireProject(
  ctx: ReadCtx,
  ownerId: string,
  projectKey: string,
): Promise<Doc<"projects">> {
  const project = await ctx.db
    .query("projects")
    .withIndex("by_owner_and_project_key", (q) =>
      q.eq("ownerId", ownerId).eq("projectKey", projectKey),
    )
    .unique();
  if (!project) throw new Error("Memory change set project does not exist.");
  return project;
}

async function requireChangeSet(
  ctx: ReadCtx,
  ownerId: string,
  projectKey: string,
  changeSetId: string,
): Promise<Doc<"memoryChangeSets">> {
  const changeSet = await ctx.db
    .query("memoryChangeSets")
    .withIndex("by_owner_and_change_set_id", (q) =>
      q.eq("ownerId", ownerId).eq("changeSetId", changeSetId),
    )
    .unique();
  if (!changeSet || changeSet.projectKey !== projectKey) {
    throw new Error("Memory change set does not exist.");
  }
  return changeSet;
}

async function appendAudit(
  ctx: MutationCtx,
  input: {
    ownerId: string;
    requestId: string;
    projectKey: string;
    eventType: string;
    actor: "user" | "agent" | "tool";
    payload: Record<string, unknown>;
    createdAt: number;
  },
): Promise<void> {
  await ctx.db.insert("auditEvents", {
    ownerId: input.ownerId,
    requestId: input.requestId,
    scopeKey: input.projectKey,
    eventType: input.eventType,
    actor: input.actor,
    payload: input.payload,
    createdAt: input.createdAt,
  });
}

function sameProposal(
  existing: Doc<"memoryChangeSets">,
  input: {
    requestId: string;
    projectKey: string;
    baseRevision: number;
    records: MemoryRecord[];
    rationale: string;
    proposedBy: "user" | "agent" | "tool";
  },
): boolean {
  return (
    existing.requestId === input.requestId &&
    existing.projectKey === input.projectKey &&
    existing.baseRevision === input.baseRevision &&
    existing.rationale === input.rationale &&
    existing.proposedBy === input.proposedBy &&
    JSON.stringify(existing.records) === JSON.stringify(input.records)
  );
}

async function recordsForChangeSet(
  ctx: ReadCtx,
  ownerId: string,
  changeSet: Doc<"memoryChangeSets">,
): Promise<Doc<"projectRecords">[]> {
  const records: Doc<"projectRecords">[] = [];
  for (const proposed of changeSet.records) {
    const row = await ctx.db
      .query("projectRecords")
      .withIndex("by_owner_and_project_key_and_record_id", (q) =>
        q
          .eq("ownerId", ownerId)
          .eq("projectKey", changeSet.projectKey)
          .eq("recordId", proposed.recordId),
      )
      .unique();
    if (!row) throw new Error(`Applied memory record ${proposed.recordId} is missing.`);
    records.push(row);
  }
  return records;
}

async function assertNoMeasurementConflicts(
  ctx: MutationCtx,
  ownerId: string,
  projectKey: string,
  records: MemoryRecord[],
): Promise<void> {
  assertUniqueMeasurementKeys(records);
  const proposedMeasurements = records.filter(
    (record): record is Extract<MemoryRecord, { kind: "measurement" }> =>
      record.kind === "measurement",
  );
  if (proposedMeasurements.length === 0) return;

  const existing = await ctx.db
    .query("projectRecords")
    .withIndex("by_owner_and_project_key_and_kind", (q) =>
      q.eq("ownerId", ownerId).eq("projectKey", projectKey).eq("kind", "measurement"),
    )
    .take(MAX_PROJECT_MEASUREMENTS + 1);
  if (existing.length > MAX_PROJECT_MEASUREMENTS) {
    throw new Error("Project contains too many measurements for safe conflict validation.");
  }

  const replacingIds = new Set(proposedMeasurements.map((record) => record.recordId));
  const keys = new Set<string>();
  for (const row of existing) {
    if (replacingIds.has(row.recordId) || row.record.kind !== "measurement") continue;
    keys.add(measurementKey(row.record));
  }
  for (const record of proposedMeasurements) {
    const key = measurementKey(record);
    if (keys.has(key)) throw new Error(`Conflicting or duplicate measurement key: ${key}.`);
    keys.add(key);
  }
}

export const stage = mutation({
  args: {
    serviceToken: v.string(),
    changeSetId: v.string(),
    requestId: v.string(),
    projectKey: v.string(),
    expectedRevision: v.number(),
    records: v.array(memoryRecordValidator),
    rationale: v.string(),
    proposedBy: memoryChangeSetActorValidator,
  },
  returns: memoryChangeSetDocumentValidator,
  handler: async (ctx, args) => {
    const ownerId = requireOwner(args.serviceToken);
    const changeSetId = cleanRequiredText(args.changeSetId, "Memory change set ID");
    const requestId = cleanRequiredText(args.requestId, "Request ID");
    const projectKey = cleanRequiredText(args.projectKey, "Project key");
    const expectedRevision = requirePositiveRevision(args.expectedRevision, "Expected revision");
    const records = normalizeMemoryRecords(args.records);
    assertUniqueMeasurementKeys(records);
    const rationale = cleanRequiredText(args.rationale, "Memory change set rationale");

    const existing = await ctx.db
      .query("memoryChangeSets")
      .withIndex("by_owner_and_change_set_id", (q) =>
        q.eq("ownerId", ownerId).eq("changeSetId", changeSetId),
      )
      .unique();
    if (existing) {
      if (
        !sameProposal(existing, {
          requestId,
          projectKey,
          baseRevision: expectedRevision,
          records,
          rationale,
          proposedBy: args.proposedBy,
        })
      ) {
        throw new Error("Memory change set ID already exists with different contents.");
      }
      return existing;
    }

    const project = await requireProject(ctx, ownerId, projectKey);
    if (project.revision !== expectedRevision) {
      throw new Error(
        `Project revision conflict: expected ${expectedRevision}, current ${project.revision}.`,
      );
    }

    const now = Date.now();
    const id = await ctx.db.insert("memoryChangeSets", {
      ownerId,
      changeSetId,
      requestId,
      projectKey,
      baseRevision: expectedRevision,
      state: "proposed",
      records,
      rationale,
      proposedBy: args.proposedBy,
      createdAt: now,
      updatedAt: now,
    });
    await appendAudit(ctx, {
      ownerId,
      requestId,
      projectKey,
      eventType: "memory.change_set.proposed",
      actor: args.proposedBy,
      payload: {
        changeSetId,
        baseRevision: expectedRevision,
        recordCount: records.length,
        recordIds: records.map((record) => record.recordId),
      },
      createdAt: now,
    });

    const created = await ctx.db.get("memoryChangeSets", id);
    if (!created) throw new Error("Memory change set creation failed.");
    return created;
  },
});

export const get = query({
  args: { serviceToken: v.string(), projectKey: v.string(), changeSetId: v.string() },
  returns: v.union(memoryChangeSetDocumentValidator, v.null()),
  handler: async (ctx, args) => {
    const ownerId = requireOwner(args.serviceToken);
    const projectKey = cleanRequiredText(args.projectKey, "Project key");
    const changeSet = await ctx.db
      .query("memoryChangeSets")
      .withIndex("by_owner_and_change_set_id", (q) =>
        q.eq("ownerId", ownerId).eq("changeSetId", args.changeSetId.trim()),
      )
      .unique();
    return changeSet?.projectKey === projectKey ? changeSet : null;
  },
});

export const listRecent = query({
  args: {
    serviceToken: v.string(),
    projectKey: v.string(),
    state: v.optional(memoryChangeSetStateValidator),
    limit: v.optional(v.number()),
  },
  returns: v.array(memoryChangeSetDocumentValidator),
  handler: async (ctx, args) => {
    const ownerId = requireOwner(args.serviceToken);
    const projectKey = cleanRequiredText(args.projectKey, "Project key");
    const limit = boundedLimit(args.limit);
    if (args.state === undefined) {
      return ctx.db
        .query("memoryChangeSets")
        .withIndex("by_owner_and_project_key", (q) =>
          q.eq("ownerId", ownerId).eq("projectKey", projectKey),
        )
        .order("desc")
        .take(limit);
    }
    return ctx.db
      .query("memoryChangeSets")
      .withIndex("by_owner_and_project_key_and_state", (q) =>
        q.eq("ownerId", ownerId).eq("projectKey", projectKey).eq("state", args.state!),
      )
      .order("desc")
      .take(limit);
  },
});

export const approve = mutation({
  args: {
    serviceToken: v.string(),
    projectKey: v.string(),
    changeSetId: v.string(),
    expectedRevision: v.number(),
  },
  returns: memoryChangeSetDocumentValidator,
  handler: async (ctx, args) => {
    const ownerId = requireOwner(args.serviceToken);
    const projectKey = cleanRequiredText(args.projectKey, "Project key");
    const changeSetId = cleanRequiredText(args.changeSetId, "Memory change set ID");
    const expectedRevision = requirePositiveRevision(args.expectedRevision, "Expected revision");
    const changeSet = await requireChangeSet(ctx, ownerId, projectKey, changeSetId);
    if (changeSet.baseRevision !== expectedRevision) {
      throw new Error(
        `Project revision conflict: expected ${expectedRevision}, proposal base ${changeSet.baseRevision}.`,
      );
    }
    if (changeSet.state === "applied") return changeSet;
    if (changeSet.state === "rejected") {
      throw new Error("Rejected memory change sets cannot be approved.");
    }

    const project = await requireProject(ctx, ownerId, changeSet.projectKey);
    if (project.revision !== expectedRevision) {
      throw new Error(
        `Project revision conflict: expected ${expectedRevision}, current ${project.revision}.`,
      );
    }

    const now = Date.now();
    await ctx.db.patch("memoryChangeSets", changeSet._id, {
      state: "approved",
      approvedBy: "user",
      approvedAt: now,
      updatedAt: now,
    });
    await appendAudit(ctx, {
      ownerId,
      requestId: changeSet.requestId,
      projectKey: changeSet.projectKey,
      eventType: "memory.change_set.approved",
      actor: "user",
      payload: { changeSetId, baseRevision: changeSet.baseRevision },
      createdAt: now,
    });

    const approved = await ctx.db.get("memoryChangeSets", changeSet._id);
    if (!approved) throw new Error("Memory change set approval failed.");
    return approved;
  },
});

export const reject = mutation({
  args: {
    serviceToken: v.string(),
    projectKey: v.string(),
    changeSetId: v.string(),
    reason: v.string(),
  },
  returns: memoryChangeSetDocumentValidator,
  handler: async (ctx, args) => {
    const ownerId = requireOwner(args.serviceToken);
    const projectKey = cleanRequiredText(args.projectKey, "Project key");
    const changeSetId = cleanRequiredText(args.changeSetId, "Memory change set ID");
    const reason = cleanRequiredText(args.reason, "Rejection reason");
    const changeSet = await requireChangeSet(ctx, ownerId, projectKey, changeSetId);
    if (changeSet.state === "applied") {
      throw new Error("Applied memory change sets cannot be rejected.");
    }
    if (changeSet.state === "rejected") return changeSet;

    const now = Date.now();
    await ctx.db.patch("memoryChangeSets", changeSet._id, {
      state: "rejected",
      rejectedBy: "user",
      rejectedReason: reason,
      rejectedAt: now,
      updatedAt: now,
    });
    await appendAudit(ctx, {
      ownerId,
      requestId: changeSet.requestId,
      projectKey: changeSet.projectKey,
      eventType: "memory.change_set.rejected",
      actor: "user",
      payload: { changeSetId, reason },
      createdAt: now,
    });

    const rejected = await ctx.db.get("memoryChangeSets", changeSet._id);
    if (!rejected) throw new Error("Memory change set rejection failed.");
    return rejected;
  },
});

export const apply = mutation({
  args: {
    serviceToken: v.string(),
    projectKey: v.string(),
    changeSetId: v.string(),
    expectedRevision: v.number(),
  },
  returns: memoryApplyResultValidator,
  handler: async (ctx, args) => {
    const ownerId = requireOwner(args.serviceToken);
    const projectKey = cleanRequiredText(args.projectKey, "Project key");
    const changeSetId = cleanRequiredText(args.changeSetId, "Memory change set ID");
    const expectedRevision = requirePositiveRevision(args.expectedRevision, "Expected revision");
    const changeSet = await requireChangeSet(ctx, ownerId, projectKey, changeSetId);
    if (changeSet.baseRevision !== expectedRevision) {
      throw new Error(
        `Project revision conflict: expected ${expectedRevision}, proposal base ${changeSet.baseRevision}.`,
      );
    }
    const project = await requireProject(ctx, ownerId, changeSet.projectKey);

    if (changeSet.state === "applied") {
      return {
        changeSet,
        project,
        records: await recordsForChangeSet(ctx, ownerId, changeSet),
        idempotent: true,
      };
    }
    if (changeSet.state !== "approved") {
      throw new Error("Only approved memory change sets can be applied.");
    }
    if (project.revision !== expectedRevision) {
      throw new Error(
        `Project revision conflict: expected ${expectedRevision}, current ${project.revision}.`,
      );
    }

    const records = normalizeMemoryRecords(changeSet.records);
    await assertNoMeasurementConflicts(ctx, ownerId, changeSet.projectKey, records);
    const now = Date.now();
    const appliedRecords: Doc<"projectRecords">[] = [];

    for (const record of records) {
      const existing = await ctx.db
        .query("projectRecords")
        .withIndex("by_owner_and_project_key_and_record_id", (q) =>
          q
            .eq("ownerId", ownerId)
            .eq("projectKey", changeSet.projectKey)
            .eq("recordId", record.recordId),
        )
        .unique();
      const values = {
        ownerId,
        projectKey: changeSet.projectKey,
        kind: record.kind,
        recordId: record.recordId,
        record,
        updatedAt: now,
      };
      if (existing) {
        await ctx.db.patch("projectRecords", existing._id, values);
        const updated = await ctx.db.get("projectRecords", existing._id);
        if (!updated) throw new Error(`Memory record ${record.recordId} update failed.`);
        appliedRecords.push(updated);
      } else {
        const id = await ctx.db.insert("projectRecords", values);
        const created = await ctx.db.get("projectRecords", id);
        if (!created) throw new Error(`Memory record ${record.recordId} creation failed.`);
        appliedRecords.push(created);
      }
    }

    const appliedRevision = expectedRevision + 1;
    await ctx.db.patch("projects", project._id, {
      revision: appliedRevision,
      updatedAt: now,
    });
    await ctx.db.patch("memoryChangeSets", changeSet._id, {
      state: "applied",
      appliedAt: now,
      appliedRevision,
      updatedAt: now,
    });
    await appendAudit(ctx, {
      ownerId,
      requestId: changeSet.requestId,
      projectKey: changeSet.projectKey,
      eventType: "memory.change_set.applied",
      actor: "user",
      payload: {
        changeSetId,
        baseRevision: expectedRevision,
        appliedRevision,
        recordIds: records.map((record) => record.recordId),
      },
      createdAt: now,
    });

    const appliedChangeSet = await ctx.db.get("memoryChangeSets", changeSet._id);
    const updatedProject = await ctx.db.get("projects", project._id);
    if (!appliedChangeSet || !updatedProject) {
      throw new Error("Memory change set apply transaction did not return updated documents.");
    }
    return {
      changeSet: appliedChangeSet,
      project: updatedProject,
      records: appliedRecords,
      idempotent: false,
    };
  },
});
