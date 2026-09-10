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
  expired = false,
  checkpointEventId?: string,
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
  if (checkpointEventId) {
    const event = await ctx.db
      .query("developmentEvents")
      .withIndex("by_owner_and_subject_id_and_event_id", (q) =>
        q.eq("ownerId", ownerId).eq("subjectId", input.subjectId).eq("eventId", checkpointEventId),
      )
      .unique();
    if (
      !step ||
      event?.eventType !== "DEV_TRANSITION_COMMITTED" ||
      event.transitionId !== "DEV_TRANSITION_BUILDING_TO_VERIFYING" ||
      event.requestedBy?.actorId !== input.workerId ||
      event.payload.leaseFencingToken !== step.leaseFencingToken ||
      step.operationId !== "github-development-worker" ||
      !["running", "pending"].includes(step.state) ||
      (step.state === "running" && step.leaseOwner !== input.workerId)
    )
      throw new Error("Current worker checkpoint and fence required for pause.");
    return { subject, step };
  }
  if (
    !step ||
    step.operationId !== "github-development-worker" ||
    step.state !== "running" ||
    step.leaseOwner !== input.workerId ||
    !step.leaseToken ||
    !step.leaseFencingToken ||
    !step.leaseExpiresAt ||
    (expired ? step.leaseExpiresAt > Date.now() : step.leaseExpiresAt <= Date.now())
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
  args: { ...args, checkpointEventId: v.optional(v.string()) },
  returns: v.null(),
  handler: async (ctx, input) => {
    const { subject, step } = await bound(ctx, input, false, input.checkpointEventId);
    if (
      !["VERIFYING", "REPAIR_REQUIRED", "REVIEW", "READY_TO_MERGE", "MERGED", "COMPLETE"].includes(
        subject.state,
      )
    )
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

/** Only trusted admission calls this after observing a finished, unpublished worker.
 * Rotate the fence before recovery checkpoints so the old worker loses authority.
 * No attempt budget is reset: the subsequent admitted worker consumes the next attempt.
 */
export const recoverExpired = mutation({
  args: { ...args, previousWorkerId: v.string(), expectedFencingToken: v.number() },
  returns: leaseValidator,
  handler: async (ctx, input) => {
    if (input.workerId === input.previousWorkerId)
      throw new Error("A distinct recovery worker is required.");
    const { subject, step } = await bound(
      ctx,
      { ...input, workerId: input.previousWorkerId },
      true,
    );
    if (
      !["CLAIMED", "BUILDING"].includes(subject.state) ||
      step.attempt >= 3 ||
      step.leaseFencingToken !== input.expectedFencingToken
    )
      throw new Error("Expired worker cannot be recovered from this state, attempt or fence.");
    const fencingToken = step.leaseFencingToken! + 1;
    const leaseToken = crypto.randomUUID();
    const expires = Date.now() + 15 * 60_000;
    await ctx.db.patch("orchestrationSteps", step._id, {
      leaseOwner: input.workerId,
      leaseToken,
      leaseFencingToken: fencingToken,
      leaseExpiresAt: expires,
      updatedAt: Date.now(),
    });
    return {
      leaseToken,
      leaseOwner: input.workerId,
      leaseExpiresAt: new Date(expires).toISOString(),
      fencingToken,
    };
  },
});

/** Finalize only after Omega has committed completion; this grants no completion authority. */
export const finalize = mutation({
  args: { serviceToken: v.string(), subjectId: v.string() },
  returns: v.null(),
  handler: async (ctx, input) => {
    const ownerId = requireOwner(input.serviceToken);
    const subject = await ctx.db
      .query("developmentSubjects")
      .withIndex("by_owner_and_subject_id", (q) =>
        q.eq("ownerId", ownerId).eq("subjectId", input.subjectId),
      )
      .unique();
    if (
      subject?.state !== "COMPLETE" ||
      !subject.omegaMissionId ||
      !subject.orchestrationRunId ||
      !subject.orchestrationNodeId
    )
      throw new Error("Authoritative Development completion required.");
    const mission = await ctx.db
      .query("omegaMissions")
      .withIndex("by_owner_and_mission_id", (q) =>
        q.eq("ownerId", ownerId).eq("missionId", subject.omegaMissionId!),
      )
      .unique();
    if (mission?.state !== "complete") throw new Error("Authoritative Omega completion required.");
    const run = await ctx.db
      .query("orchestrationRuns")
      .withIndex("by_owner_and_run_id", (q) =>
        q.eq("ownerId", ownerId).eq("runId", subject.orchestrationRunId!),
      )
      .unique();
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
      !run ||
      !step ||
      run.nodeIds.length !== 1 ||
      run.nodeIds[0] !== step.nodeId ||
      run.triggerKind !== "github-development-mission" ||
      step.operationId !== "github-development-worker"
    )
      throw new Error("Bound single-worker Development orchestration required.");
    if (run.state === "succeeded" && step.state === "succeeded") return null;
    if (run.state !== "running" || step.state !== "pending" || step.leaseToken)
      throw new Error("Paused Development worker required before finalization.");
    const now = Date.now();
    await ctx.db.patch("orchestrationSteps", step._id, {
      state: "succeeded",
      completedAt: now,
      updatedAt: now,
    });
    await ctx.db.patch("orchestrationRuns", run._id, {
      state: "succeeded",
      completedStepIds: [step.nodeId],
      updatedAt: now,
      checkpointNodeId: step.nodeId,
      checkpointAt: now,
      checkpointSequence: run.checkpointSequence + 1,
      recoveryState: run.recoveryState === "none" ? "none" : "recovered",
    });
    return null;
  },
});
