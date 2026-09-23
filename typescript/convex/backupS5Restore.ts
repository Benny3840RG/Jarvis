import type { MutationCtx } from "./_generated/server.js";
import type { TableNames } from "./_generated/dataModel.js";
import { requireApprovalToken, requireOwner } from "./authHelpers.js";
import schema from "./schema.js";
import {
  readS5TerminalOrchestration,
  S5_TABLES,
  type S5EncodedCapture,
  type S5TerminalIdentities,
} from "../src/backup/v4/s5TerminalOrchestration.js";

/** Unregistered v4 restore adapter. No public mutation and no archive sealing. */
export async function restoreS5TerminalOrchestration(
  ctx: MutationCtx,
  input: S5EncodedCapture & { serviceToken: string; approvalToken: string },
): Promise<S5TerminalIdentities> {
  const ownerId = requireOwner(input.serviceToken);
  requireApprovalToken(input.approvalToken);
  const source = readS5TerminalOrchestration(input);
  if (source.ownerId !== ownerId) throw new Error("S5 source owner does not match restore owner.");
  for (const table of Object.keys(schema.tables) as TableNames[]) {
    if ((await ctx.db.query(table).take(1)).length)
      throw new Error("S5 isolated restore requires an empty application database.");
  }
  for (const table of S5_TABLES)
    for (const row of source[table]) {
      if (!ctx.db.normalizeId(table, row._id))
        throw new Error("Invalid S5 source physical identity.");
    }
  const identities: S5TerminalIdentities = {
    orchestrationRuns: [],
    orchestrationSteps: [],
    orchestrationReconciliations: [],
  };
  for (const row of source.orchestrationRuns) {
    const { _id, _creationTime, ...fields } = row;
    const targetId = await ctx.db.insert("orchestrationRuns", fields);
    identities.orchestrationRuns.push({
      sourceId: _id,
      targetId,
      sourceCreationTime: _creationTime,
    });
  }
  for (const row of source.orchestrationSteps) {
    const { _id, _creationTime, ...fields } = row;
    const targetId = await ctx.db.insert("orchestrationSteps", fields);
    identities.orchestrationSteps.push({
      sourceId: _id,
      targetId,
      sourceCreationTime: _creationTime,
    });
  }
  for (const row of source.orchestrationReconciliations) {
    const { _id, _creationTime, ...fields } = row;
    const targetId = await ctx.db.insert("orchestrationReconciliations", fields);
    identities.orchestrationReconciliations.push({
      sourceId: _id,
      targetId,
      sourceCreationTime: _creationTime,
    });
  }
  return identities;
}
