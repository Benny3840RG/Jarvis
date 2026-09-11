import { readBackupTables, buildS6Capture } from "./backupCaptureTables.js";
import { v } from "convex/values";
import { query } from "./_generated/server.js";
import { requireOwner, requireApprovalToken } from "./authHelpers.js";
import { S6_TABLES } from "../src/backup/v4/s6MutableQuotes.js";

/** Provider-consistent raw material; the supplied S3 digest is an archive binding, not filesystem proof. */
export const capture = query({
  args: { serviceToken: v.string(), approvalToken: v.string(), businessChecksum: v.string() },
  returns: v.object({
    payloadJson: v.string(),
    payloadSha256: v.string(),
    restoreVerified: v.literal(false),
  }),
  handler: async (ctx, args) => {
    const ownerId = requireOwner(args.serviceToken);
    requireApprovalToken(args.approvalToken);
    if (!/^sha256:[a-f0-9]{64}$/.test(args.businessChecksum))
      throw new Error("Invalid business checksum.");
    return buildS6Capture(
      ownerId,
      Date.now(),
      args.businessChecksum,
      await readBackupTables(ctx, ownerId, S6_TABLES, () => 100),
    );
  },
});
