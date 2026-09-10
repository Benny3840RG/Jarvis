import { v } from "convex/values";
import { requireOwner } from "./authHelpers.js";
import { mutation, query, type QueryCtx, type MutationCtx } from "./_generated/server.js";

const args = { serviceToken: v.string(), subjectId: v.string(), workerId: v.string() };
const leaseValidator = v.object({
  leaseToken: v.string(),
  leaseOwner: v.string(),
  leaseExpiresAt: v.string(),
  fencingToken: v.number(),
});
async function bound(
  ctx: QueryCtx | MutationCtx,
  input: { serviceToken: string; subjectId: string; workerId: string },
) {
  const ownerId = requireOwner(input.serviceToken);
  const subject = await ctx.db
    .query("developmentSubjects")
    .withIndex("by_owner_and_subject_id", (q) =>
      q.eq("ownerId", ownerId).eq("subjectId", input.subjectId),
    )
    .unique();
  if (!subject?.orchestrationRunId || !subject.orchestrationNodeId)
    throw new Error("Bound Development subject required.");
  const run = await ctx.db
    .query("orchestrationRuns")
    .withIndex("by_owner_and_run_id", (q) =>
      q.eq("ownerId", ownerId).eq("runId", subject.orchestrationRunId!),
    )
    .unique();
  if (run?.state !== "running") throw new Error("Active Development orchestration run required.");
  const step = await ctx.db
    .query("orchestrationSteps")
    .withIndex("by_owner_and_run_id_and_node_id", (q) =>
      q
        .eq("ownerId", ownerId)
        .eq("runId", subject.orchestrationRunId!)
        .eq("nodeId", subject.orchestrationNodeId!),
    )
    .unique();
  if (
    !step ||
    step.operationId !== "github-development-worker" ||
    step.state !== "running" ||
    step.leaseOwner !== input.workerId ||
    !step.leaseToken ||
    !step.leaseFencingToken ||
    !step.leaseExpiresAt ||
    step.leaseExpiresAt <= Date.now()
  )
    throw new Error("Current live Development worker lease required.");
  return { subject, step };
}

/** Trusted control-runner access only; never expose the returned token to candidate workers. */
export const get = query({
  args,
  returns: leaseValidator,
  handler: async (ctx, input) => {
    const { step } = await bound(ctx, input);
    return {
      leaseToken: step.leaseToken!,
      leaseOwner: input.workerId,
      leaseExpiresAt: new Date(step.leaseExpiresAt!).toISOString(),
      fencingToken: step.leaseFencingToken!,
    };
  },
});

export const renew = mutation({
  args,
  returns: leaseValidator,
  handler: async (ctx, input) => {
    const { subject, step } = await bound(ctx, input);
    if (!["READY", "CLAIMED", "BUILDING", "REPAIR_REQUIRED"].includes(subject.state))
      throw new Error("Worker stage is not active.");
    const expires = Date.now() + 15 * 60_000;
    await ctx.db.patch("orchestrationSteps", step._id, {
      leaseExpiresAt: expires,
      updatedAt: Date.now(),
    });
    return {
      leaseToken: step.leaseToken!,
      leaseOwner: input.workerId,
      leaseExpiresAt: new Date(expires).toISOString(),
      fencingToken: step.leaseFencingToken!,
    };
  },
});

/** Pause between worker invocations, retaining the monotonic fence and durable history. */
export const pause = mutation({
  args,
  returns: v.null(),
  handler: async (ctx, input) => {
    const { subject, step } = await bound(ctx, input);
    if (!["VERIFYING", "REPAIR_REQUIRED"].includes(subject.state))
      throw new Error("Durable worker checkpoint required before pause.");
    await ctx.db.patch("orchestrationSteps", step._id, {
      state: "pending",
      updatedAt: Date.now(),
      leaseOwner: undefined,
      leaseToken: undefined,
      leaseExpiresAt: undefined,
    });
    return null;
  },
});
