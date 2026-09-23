import { v } from "convex/values";

import { requireApprovalToken, requireOwner } from "./authHelpers.js";
import type { Doc } from "./_generated/dataModel.js";
import { query, type QueryCtx } from "./_generated/server.js";
import { encodeS4Payload } from "../src/backup/v4/convexCapture.js";
import {
  S5_CAPTURE_VERSION,
  S5_MAX_ROWS_PER_TABLE,
  S5_MAX_TOTAL_ROWS,
  S5_TABLES,
} from "../src/backup/v4/s5TerminalOrchestration.js";

async function readOwnerTable(
  ctx: QueryCtx,
  ownerId: string,
  table: (typeof S5_TABLES)[number],
): Promise<Array<Doc<(typeof S5_TABLES)[number]>>> {
  const rows =
    table === "orchestrationRuns"
      ? await ctx.db
          .query("orchestrationRuns")
          .withIndex("by_owner_and_run_id", (q) => q.eq("ownerId", ownerId))
          .take(S5_MAX_ROWS_PER_TABLE + 1)
      : table === "orchestrationSteps"
        ? await ctx.db
            .query("orchestrationSteps")
            .withIndex("by_owner_and_run_id_and_node_id", (q) => q.eq("ownerId", ownerId))
            .take(S5_MAX_ROWS_PER_TABLE + 1)
        : await ctx.db
            .query("orchestrationReconciliations")
            .withIndex("by_owner_and_reconciliation_id", (q) => q.eq("ownerId", ownerId))
            .take(S5_MAX_ROWS_PER_TABLE + 1);
  if (rows.length > S5_MAX_ROWS_PER_TABLE)
    throw new Error("S5 capture table exceeds its row bound.");
  return rows.sort(
    (a, b) => a._creationTime - b._creationTime || (a._id < b._id ? -1 : a._id > b._id ? 1 : 0),
  );
}

/** Read-only raw S5 material. Terminal validation happens at restore, not here. */
export const capture = query({
  args: { serviceToken: v.string(), approvalToken: v.string() },
  returns: v.object({
    version: v.literal(S5_CAPTURE_VERSION),
    provider: v.literal("convex"),
    ownerId: v.string(),
    capturedAt: v.number(),
    tableCounts: v.array(v.object({ table: v.string(), rowCount: v.number() })),
    totalRows: v.number(),
    payloadJson: v.string(),
    payloadSha256: v.string(),
    restoreVerified: v.literal(false),
  }),
  handler: async (ctx, args) => {
    const ownerId = requireOwner(args.serviceToken);
    requireApprovalToken(args.approvalToken);
    const capturedAt = Date.now();
    const tables = [];
    let totalRows = 0;
    for (const table of S5_TABLES) {
      const documents = await readOwnerTable(ctx, ownerId, table);
      totalRows += documents.length;
      if (totalRows > S5_MAX_TOTAL_ROWS) throw new Error("S5 capture exceeds its total row limit.");
      tables.push({ table, documents });
    }
    return {
      version: S5_CAPTURE_VERSION as typeof S5_CAPTURE_VERSION,
      provider: "convex" as const,
      ownerId,
      capturedAt,
      tableCounts: tables.map(({ table, documents }) => ({ table, rowCount: documents.length })),
      totalRows,
      ...encodeS4Payload({
        version: S5_CAPTURE_VERSION,
        provider: "convex",
        ownerId,
        capturedAt,
        tables,
      }),
      restoreVerified: false as const,
    };
  },
});
