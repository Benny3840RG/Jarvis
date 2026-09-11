import { requireOwner, requireApprovalToken } from "./authHelpers.js";
import type { MutationCtx } from "./_generated/server.js";
import type { TableNames } from "./_generated/dataModel.js";
import schema from "./schema.js";
import type { BusinessRecordsPayload } from "../src/backup/v4/businessSource.js";
import {
  readS6MutableQuotes,
  type S6Capture,
  type S6Source,
  type S6Identities,
} from "../src/backup/v4/s6MutableQuotes.js";

/** Unregistered primitive. Node preflight/readback supplies actual S3 proof; this proves logical closure only. */
export async function restoreS6MutableQuotes(
  ctx: MutationCtx,
  input: S6Capture & {
    serviceToken: string;
    approvalToken: string;
    business: BusinessRecordsPayload;
  },
): Promise<S6Identities> {
  const ownerId = requireOwner(input.serviceToken);
  requireApprovalToken(input.approvalToken);
  const source = readS6MutableQuotes(input, input.business);
  if (source.ownerId !== ownerId) throw new Error("S6 source owner mismatch.");
  for (const table of Object.keys(schema.tables) as TableNames[])
    if ((await ctx.db.query(table).take(1)).length)
      throw new Error("S6 isolated restore requires an empty application database.");
  validateS6PhysicalIds(ctx, source);
  return insertS6Rows(ctx, source);
}
export function validateS6PhysicalIds(ctx: Pick<MutationCtx, "db">, source: S6Source): void {
  for (const row of source.quotes)
    if (!ctx.db.normalizeId("quotes", row._id)) throw new Error("Invalid quote physical identity.");
  for (const row of source.quoteRevisions)
    if (!ctx.db.normalizeId("quoteRevisions", row._id))
      throw new Error("Invalid revision physical identity.");
}
/** Typed insertion only; complete preflight and empty-target guard belong to its calling transaction. */
export async function insertS6Rows(ctx: MutationCtx, source: S6Source): Promise<S6Identities> {
  const identities: S6Identities = { quotes: [], quoteRevisions: [] };
  for (const row of source.quotes) {
    const { _id, _creationTime, ...fields } = row;
    const targetId = await ctx.db.insert("quotes", fields);
    identities.quotes.push({ sourceId: _id, targetId, sourceCreationTime: _creationTime });
  }
  for (const row of source.quoteRevisions) {
    const { _id, _creationTime, ...fields } = row;
    const targetId = await ctx.db.insert("quoteRevisions", fields);
    identities.quoteRevisions.push({ sourceId: _id, targetId, sourceCreationTime: _creationTime });
  }
  return identities;
}
