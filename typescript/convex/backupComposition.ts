import { requireOwner, requireApprovalToken } from "./authHelpers.js";
import type { MutationCtx } from "./_generated/server.js";
import type { TableNames } from "./_generated/dataModel.js";
import schema from "./schema.js";
import { readS4ProjectNotes, type S4EncodedCapture } from "../src/backup/v4/s4ProjectNotes.js";
import { readS6MutableQuotes, type S6Capture } from "../src/backup/v4/s6MutableQuotes.js";
import type { BusinessRecordsPayload } from "../src/backup/v4/businessSource.js";
import { insertS4Rows, validateS4PhysicalIds } from "./backupS4Restore.js";
import { insertS6Rows, validateS6PhysicalIds } from "./backupS6Restore.js";
/** Unregistered composition primitive; caller supplies one isolated transaction, never serial live restores. */
export async function restoreS4S6(
  ctx: MutationCtx,
  input: {
    s4: S4EncodedCapture;
    s6: S6Capture;
    business: BusinessRecordsPayload;
    serviceToken: string;
    approvalToken: string;
  },
) {
  const ownerId = requireOwner(input.serviceToken);
  requireApprovalToken(input.approvalToken);
  const s4 = readS4ProjectNotes(input.s4),
    s6 = readS6MutableQuotes(input.s6, input.business, input.s4);
  if (s4.ownerId !== ownerId || s6.ownerId !== ownerId)
    throw new Error("Composition source owner mismatch.");
  validateS4PhysicalIds(ctx, s4);
  validateS6PhysicalIds(ctx, s6);
  for (const table of Object.keys(schema.tables) as TableNames[])
    if ((await ctx.db.query(table).take(1)).length)
      throw new Error("Joint isolated restore requires an empty application database.");
  return { s4: await insertS4Rows(ctx, s4), s6: await insertS6Rows(ctx, s6) };
}
