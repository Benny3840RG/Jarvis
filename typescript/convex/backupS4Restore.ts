import { requireOwner, requireApprovalToken } from "./authHelpers.js";
import type { MutationCtx } from "./_generated/server.js";
import type { TableNames } from "./_generated/dataModel.js";
import schema from "./schema.js";
import {
  readS4ProjectNotes,
  type S4EncodedCapture,
  type S4ProjectNotesSource,
  S4_RESTORE_TABLES,
  type S4ProjectNotesIdentities,
} from "../src/backup/v4/s4ProjectNotes.js";

/** Unregistered v4 restore adapter primitive: no public mutation or live entry point. */
export async function restoreS4ProjectNotes(
  ctx: MutationCtx,
  input: S4EncodedCapture & { serviceToken: string; approvalToken: string },
): Promise<S4ProjectNotesIdentities> {
  const ownerId = requireOwner(input.serviceToken);
  requireApprovalToken(input.approvalToken);
  const source = readS4ProjectNotes(input);
  if (source.ownerId !== ownerId) throw new Error("S4 source owner does not match restore owner.");
  // A fresh application database only, including foreign-owner and non-S4 rows.
  for (const table of Object.keys(schema.tables) as TableNames[]) {
    if ((await ctx.db.query(table).take(1)).length)
      throw new Error("S4 isolated restore requires an empty application database.");
  }
  validateS4PhysicalIds(ctx, source);
  return insertS4Rows(ctx, source);
}

export function validateS4PhysicalIds(
  ctx: Pick<MutationCtx, "db">,
  source: S4ProjectNotesSource,
): void {
  for (const table of S4_RESTORE_TABLES)
    for (const row of source[table]) {
      if (!ctx.db.normalizeId(table, row._id))
        throw new Error("Invalid S4 source physical identity.");
    }
}
/** Typed insertion only; called after authentication, complete preflight and one empty-target check. */
export async function insertS4Rows(
  ctx: MutationCtx,
  source: S4ProjectNotesSource,
): Promise<S4ProjectNotesIdentities> {
  const identities: S4ProjectNotesIdentities = {
    projects: [],
    notes: [],
    projectRecords: [],
    memoryChangeSets: [],
    toolActions: [],
    auditEvents: [],
  };
  for (const row of source.projects) {
    const { _id, _creationTime, ...fields } = row;
    const targetId = await ctx.db.insert("projects", fields);
    identities.projects.push({ sourceId: _id, targetId, sourceCreationTime: _creationTime });
  }
  for (const row of source.notes) {
    const { _id, _creationTime, ...fields } = row;
    const targetId = await ctx.db.insert("notes", fields);
    identities.notes.push({ sourceId: _id, targetId, sourceCreationTime: _creationTime });
  }
  for (const row of source.projectRecords) {
    const { _id, _creationTime, ...fields } = row;
    const targetId = await ctx.db.insert("projectRecords", fields);
    identities.projectRecords.push({ sourceId: _id, targetId, sourceCreationTime: _creationTime });
  }
  for (const row of source.memoryChangeSets) {
    const { _id, _creationTime, ...fields } = row;
    const targetId = await ctx.db.insert("memoryChangeSets", fields);
    identities.memoryChangeSets.push({
      sourceId: _id,
      targetId,
      sourceCreationTime: _creationTime,
    });
  }
  for (const row of source.toolActions) {
    const { _id, _creationTime, ...fields } = row;
    const targetId = await ctx.db.insert("toolActions", fields);
    identities.toolActions.push({ sourceId: _id, targetId, sourceCreationTime: _creationTime });
  }
  for (const row of source.auditEvents) {
    const { _id, _creationTime, ...fields } = row;
    const targetId = await ctx.db.insert("auditEvents", fields);
    identities.auditEvents.push({ sourceId: _id, targetId, sourceCreationTime: _creationTime });
  }
  return identities;
}
