import { requireOwner, requireApprovalToken } from "./authHelpers.js";
import type { MutationCtx } from "./_generated/server.js";
import type { TableNames } from "./_generated/dataModel.js";
import schema from "./schema.js";
import {
  readS4ProjectNotes,
  type S4EncodedCapture,
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
  const identities: S4ProjectNotesIdentities = {
    projects: [],
    notes: [],
    projectRecords: [],
    memoryChangeSets: [],
    auditEvents: [],
  };
  for (const row of source.projects) {
    const { _id, _creationTime, ...fields } = row;
    if (!ctx.db.normalizeId("projects", _id))
      throw new Error("Invalid projects source physical ID.");
    const targetId = await ctx.db.insert("projects", fields);
    identities.projects.push({ sourceId: _id, targetId, sourceCreationTime: _creationTime });
  }
  for (const row of source.notes) {
    const { _id, _creationTime, ...fields } = row;
    if (!ctx.db.normalizeId("notes", _id)) throw new Error("Invalid notes source physical ID.");
    const targetId = await ctx.db.insert("notes", fields);
    identities.notes.push({ sourceId: _id, targetId, sourceCreationTime: _creationTime });
  }
  for (const row of source.projectRecords) {
    const { _id, _creationTime, ...fields } = row;
    if (!ctx.db.normalizeId("projectRecords", _id))
      throw new Error("Invalid projectRecords source physical ID.");
    const targetId = await ctx.db.insert("projectRecords", fields);
    identities.projectRecords.push({ sourceId: _id, targetId, sourceCreationTime: _creationTime });
  }
  for (const row of source.memoryChangeSets) {
    const { _id, _creationTime, ...fields } = row;
    if (!ctx.db.normalizeId("memoryChangeSets", _id))
      throw new Error("Invalid memoryChangeSets source physical ID.");
    const targetId = await ctx.db.insert("memoryChangeSets", fields);
    identities.memoryChangeSets.push({
      sourceId: _id,
      targetId,
      sourceCreationTime: _creationTime,
    });
  }
  for (const row of source.auditEvents) {
    const { _id, _creationTime, ...fields } = row;
    if (!ctx.db.normalizeId("auditEvents", _id))
      throw new Error("Invalid auditEvents source physical ID.");
    const targetId = await ctx.db.insert("auditEvents", fields);
    identities.auditEvents.push({ sourceId: _id, targetId, sourceCreationTime: _creationTime });
  }
  return identities;
}
