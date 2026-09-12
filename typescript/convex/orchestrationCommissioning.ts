import { v } from "convex/values";

import { requireOwner } from "./authHelpers.js";
import { mutation, type MutationCtx } from "./_generated/server.js";

/**
 * Bounded cleanup for isolated-ingress commissioning drill records (#324).
 *
 * The development Convex database is persistent and shared under a single
 * owner id, so cleanup must never be a blanket delete: `purgeCommissioningRun`
 * removes only runs that this exact campaign created — proven by the fixed
 * commissioning policy version, trigger kind, and the campaign id stamped into
 * the run's allowlisted trigger metadata — and only the run ids the caller
 * explicitly recorded. A run that does not match every check aborts the whole
 * transaction; nothing is deleted.
 */
const COMMISSIONING_POLICY_VERSION = "commissioning-isolated-ingress:v1";
const COMMISSIONING_TRIGGER_KIND = "isolated-ingress-probe";
const MAX_RUN_IDS = 50;
const MAX_CHILDREN_PER_RUN = 200;

function cleanRequired(value: string, label: string): string {
  const cleaned = value.trim();
  if (!cleaned) throw new Error(`${label} cannot be empty.`);
  if (cleaned.length > 200) throw new Error(`${label} exceeds 200 characters.`);
  return cleaned;
}

async function deleteRunChildren(
  ctx: MutationCtx,
  table: "orchestrationSteps" | "orchestrationReconciliations",
  ownerId: string,
  runId: string,
): Promise<number> {
  const rows = await ctx.db
    .query(table)
    .withIndex("by_owner_and_run_id_and_node_id", (q) =>
      q.eq("ownerId", ownerId).eq("runId", runId),
    )
    .take(MAX_CHILDREN_PER_RUN + 1);
  if (rows.length > MAX_CHILDREN_PER_RUN) {
    throw new Error(`Commissioning run ${runId} has more ${table} rows than cleanup permits.`);
  }
  for (const row of rows) {
    if ("state" in row && row.state !== "succeeded" && row.state !== "failed")
      throw new Error("Cleanup refuses a nonterminal step.");
    if (
      "leaseExpiresAt" in row &&
      typeof row.leaseExpiresAt === "number" &&
      row.leaseExpiresAt > Date.now()
    )
      throw new Error("Cleanup refuses an active lease.");
    await ctx.db.delete(table, row._id);
  }
  return rows.length;
}

export const purgeCommissioningRun = mutation({
  args: {
    serviceToken: v.string(),
    campaignId: v.string(),
    runIds: v.array(v.string()),
  },
  returns: v.object({
    campaignId: v.string(),
    deleted: v.array(
      v.object({
        runId: v.string(),
        steps: v.number(),
        reconciliations: v.number(),
      }),
    ),
    notFound: v.array(v.string()),
  }),
  handler: async (ctx, args) => {
    const ownerId = requireOwner(args.serviceToken);
    const campaignId = cleanRequired(args.campaignId, "Commissioning campaign id");
    const runIds = [...new Set(args.runIds.map((runId) => cleanRequired(runId, "Run id")))];
    if (runIds.length === 0) throw new Error("At least one run id is required.");
    if (runIds.length > MAX_RUN_IDS) {
      throw new Error(`Cleanup accepts at most ${MAX_RUN_IDS} run ids per call.`);
    }

    const deleted: Array<{ runId: string; steps: number; reconciliations: number }> = [];
    const notFound: string[] = [];

    for (const runId of runIds) {
      const run = await ctx.db
        .query("orchestrationRuns")
        .withIndex("by_owner_and_run_id", (q) => q.eq("ownerId", ownerId).eq("runId", runId))
        .unique();
      if (run === null) {
        notFound.push(runId);
        continue;
      }
      const stampedCampaign =
        typeof run.triggerPayload.campaignId === "string"
          ? run.triggerPayload.campaignId
          : undefined;
      if (
        run.policyVersion !== COMMISSIONING_POLICY_VERSION ||
        run.triggerKind !== COMMISSIONING_TRIGGER_KIND ||
        stampedCampaign !== campaignId
      ) {
        throw new Error(
          `Run ${runId} is not a member of commissioning campaign ${campaignId}; refusing to delete anything.`,
        );
      }

      if (run.state !== "succeeded" && run.state !== "failed")
        throw new Error("Cleanup refuses a nonterminal or unresolved run.");

      const steps = await deleteRunChildren(ctx, "orchestrationSteps", ownerId, runId);
      const reconciliations = await deleteRunChildren(
        ctx,
        "orchestrationReconciliations",
        ownerId,
        runId,
      );
      await ctx.db.delete("orchestrationRuns", run._id);
      deleted.push({ runId, steps, reconciliations });
    }

    return { campaignId, deleted, notFound };
  },
});
