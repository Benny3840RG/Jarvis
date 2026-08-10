import { v } from "convex/values";

import { requireOwner } from "./authHelpers.js";
import { claimOmegaExecutionContract } from "./omegaExecutionGate.js";
import {
  clampApprovalTtlMs,
  cleanRequiredText,
  deriveConsumptionPolicy,
  isApprovalExpired,
  normaliseAuditPayload,
  normaliseToolArguments,
  requirePositiveRevision,
  sameToolActionProposal,
  validateToolAuthority,
} from "./toolActionLogic.js";
import { toConvexSafetyBinding } from "./safetyBindingValidators.js";
import {
  toolActionActorValidator,
  toolActionDocumentValidator,
  toolActionStateValidator,
  toolAuthorityValidator,
} from "./toolActionValidators.js";
import { mutation, query, type MutationCtx, type QueryCtx } from "./_generated/server.js";
import type { Doc } from "./_generated/dataModel.js";
import { bindSafety, type SafetyPhase } from "../src/safety/safetyBinder.js";

const toolActionViewValidator = v.object({
  ...toolActionDocumentValidator.fields,
  isApprovalExpired: v.boolean(),
});

/** Adds the read-only, non-persisted `isApprovalExpired` view field a query can compute freely. */
function withApprovalExpiryView(
  action: Doc<"toolActions">,
  now: number,
): Doc<"toolActions"> & { isApprovalExpired: boolean } {
  return {
    ...action,
    isApprovalExpired:
      action.state === "approved" && action.approvalExpiryPolicy !== undefined
        ? isApprovalExpired(
            { policy: action.approvalExpiryPolicy, expiresAt: action.approvalExpiresAt },
            now,
          )
        : false,
  };
}

const MAX_LIST_LIMIT = 100;
const DEFAULT_LIST_LIMIT = 25;

type ReadCtx = QueryCtx | MutationCtx;

const COMPLETED_RECEIPT_STATUSES = new Set(["succeeded", "failed", "indeterminate"]);

/**
 * A single-use action is "consumed" once any execution attempt against it
 * reached a terminal, non-blocked, non-dry-run outcome — as opposed to being
 * turned away by an earlier guard (blocked) or a validation-only run
 * (dry-run). Bounded read: a correctly single-use action has at most one
 * such receipt; the small `take` bound guards against ever scanning
 * unbounded history even if that invariant is violated.
 */
async function hasCompletedExecutionReceipt(
  ctx: ReadCtx,
  ownerId: string,
  actionId: string,
): Promise<boolean> {
  const receipts = await ctx.db
    .query("toolExecutionReceipts")
    .withIndex("by_owner_and_action_id", (q) => q.eq("ownerId", ownerId).eq("actionId", actionId))
    .take(20);
  return receipts.some((receipt) => COMPLETED_RECEIPT_STATUSES.has(receipt.status));
}

function boundedLimit(limit: number | undefined): number {
  const resolved = limit ?? DEFAULT_LIST_LIMIT;
  if (!Number.isInteger(resolved) || resolved < 1 || resolved > MAX_LIST_LIMIT) {
    throw new Error(`Limit must be an integer between 1 and ${MAX_LIST_LIMIT}.`);
  }
  return resolved;
}

async function requireProject(
  ctx: ReadCtx,
  ownerId: string,
  projectKey: string,
): Promise<Doc<"projects">> {
  const project = await ctx.db
    .query("projects")
    .withIndex("by_owner_and_project_key", (q) =>
      q.eq("ownerId", ownerId).eq("projectKey", projectKey),
    )
    .unique();
  if (!project) throw new Error("Tool action project does not exist.");
  return project;
}

async function requireAction(
  ctx: ReadCtx,
  ownerId: string,
  projectKey: string,
  actionId: string,
): Promise<Doc<"toolActions">> {
  const action = await ctx.db
    .query("toolActions")
    .withIndex("by_owner_and_action_id", (q) => q.eq("ownerId", ownerId).eq("actionId", actionId))
    .unique();
  if (!action || action.projectKey !== projectKey) {
    throw new Error("Tool action does not exist.");
  }
  return action;
}

function safetyBindingForAction(
  phase: Extract<SafetyPhase, "tool-stage" | "tool-approve" | "tool-revoke">,
  action: {
    destructive: boolean;
    requiredAuthority: "T0" | "T1" | "T2" | "T3";
    idempotencyKey: string;
    requestId: string;
  },
  approvalPresent: boolean,
): ReturnType<typeof toConvexSafetyBinding> {
  return toConvexSafetyBinding(
    bindSafety({
      phase,
      riskLevel: action.destructive ? "high" : "moderate",
      hazards: action.destructive ? ["destructive tool action"] : ["governed tool action"],
      controls: ["allowlisted execution", "approval", "idempotency"],
      domainBound: true,
      memorySafe: true,
      reliabilityHealthy: true,
      proposalSafe: true,
      toolAllowlisted: true,
      requiredAuthority: action.requiredAuthority,
      grantedAuthority: action.requiredAuthority,
      actionState: phase === "tool-stage" ? "propose" : "approve",
      requiresApproval: phase !== "tool-stage",
      approvalPresent,
      destructive: action.destructive,
      idempotencyKey: action.idempotencyKey,
      correlationId: action.requestId,
      stateValid: true,
      outcome: "pending",
      recoveryAvailable: true,
    }),
  );
}

async function appendAudit(
  ctx: MutationCtx,
  input: {
    ownerId: string;
    requestId: string;
    projectKey: string;
    eventType: string;
    actor: "user" | "agent" | "tool";
    payload: Record<string, unknown>;
    createdAt: number;
  },
): Promise<void> {
  await ctx.db.insert("auditEvents", {
    ownerId: input.ownerId,
    requestId: input.requestId,
    scopeKey: input.projectKey,
    eventType: input.eventType,
    actor: input.actor,
    payload: normaliseAuditPayload(input.payload),
    createdAt: input.createdAt,
  });
}

export const stage = mutation({
  args: {
    serviceToken: v.string(),
    actionId: v.string(),
    requestId: v.string(),
    projectKey: v.string(),
    expectedRevision: v.number(),
    tool: v.string(),
    operation: v.string(),
    arguments: v.record(v.string(), v.any()),
    rationale: v.string(),
    requiredAuthority: toolAuthorityValidator,
    destructive: v.boolean(),
    idempotencyKey: v.string(),
    proposedBy: toolActionActorValidator,
  },
  returns: toolActionDocumentValidator,
  handler: async (ctx, args) => {
    const ownerId = requireOwner(args.serviceToken);
    const actionId = cleanRequiredText(args.actionId, "Tool action ID");
    const requestId = cleanRequiredText(args.requestId, "Request ID");
    const projectKey = cleanRequiredText(args.projectKey, "Project key");
    const expectedRevision = requirePositiveRevision(args.expectedRevision, "Expected revision");
    const tool = cleanRequiredText(args.tool, "Tool name");
    const operation = cleanRequiredText(args.operation, "Tool operation");
    const rationale = cleanRequiredText(args.rationale, "Tool action rationale");
    const idempotencyKey = cleanRequiredText(args.idempotencyKey, "Tool idempotency key");
    const normalisedArguments = normaliseToolArguments(args.arguments);
    validateToolAuthority(args.requiredAuthority, args.destructive);

    const proposal = {
      projectKey,
      baseRevision: expectedRevision,
      tool,
      operation,
      arguments: normalisedArguments,
      rationale,
      requiredAuthority: args.requiredAuthority,
      destructive: args.destructive,
      idempotencyKey,
      proposedBy: args.proposedBy,
    };

    const existing = await ctx.db
      .query("toolActions")
      .withIndex("by_owner_and_action_id", (q) => q.eq("ownerId", ownerId).eq("actionId", actionId))
      .unique();
    if (existing) {
      if (!sameToolActionProposal(existing, proposal)) {
        throw new Error("Tool action ID already exists with different contents.");
      }
      return existing;
    }

    const existingIdempotencyKey = await ctx.db
      .query("toolActions")
      .withIndex("by_owner_and_idempotency_key", (q) =>
        q.eq("ownerId", ownerId).eq("idempotencyKey", idempotencyKey),
      )
      .unique();
    if (existingIdempotencyKey) {
      throw new Error("Tool idempotency key already belongs to another action.");
    }

    const project = await requireProject(ctx, ownerId, projectKey);
    if (project.revision !== expectedRevision) {
      throw new Error(
        `Project revision conflict: expected ${expectedRevision}, current ${project.revision}.`,
      );
    }

    const now = Date.now();
    const safetyBinding = safetyBindingForAction("tool-stage", { ...proposal, requestId }, false);
    const id = await ctx.db.insert("toolActions", {
      ownerId,
      actionId,
      requestId,
      ...proposal,
      safetyBinding,
      state: "proposed",
      createdAt: now,
      updatedAt: now,
    });
    await appendAudit(ctx, {
      ownerId,
      requestId,
      projectKey,
      eventType: "tool.action.proposed",
      actor: args.proposedBy,
      payload: {
        actionId,
        tool,
        operation,
        baseRevision: expectedRevision,
        requiredAuthority: args.requiredAuthority,
        destructive: args.destructive,
        idempotencyKey,
        safetyBinding,
      },
      createdAt: now,
    });

    const created = await ctx.db.get("toolActions", id);
    if (!created) throw new Error("Tool action creation failed.");
    return created;
  },
});

export const get = query({
  args: {
    serviceToken: v.string(),
    projectKey: v.string(),
    actionId: v.string(),
    now: v.optional(v.number()),
  },
  returns: v.union(toolActionViewValidator, v.null()),
  handler: async (ctx, args) => {
    const ownerId = requireOwner(args.serviceToken);
    const projectKey = cleanRequiredText(args.projectKey, "Project key");
    const action = await ctx.db
      .query("toolActions")
      .withIndex("by_owner_and_action_id", (q) =>
        q.eq("ownerId", ownerId).eq("actionId", args.actionId.trim()),
      )
      .unique();
    if (action?.projectKey !== projectKey) return null;
    return withApprovalExpiryView(action, args.now ?? Date.now());
  },
});

export const listRecent = query({
  args: {
    serviceToken: v.string(),
    projectKey: v.string(),
    state: v.optional(toolActionStateValidator),
    limit: v.optional(v.number()),
    now: v.optional(v.number()),
  },
  returns: v.array(toolActionViewValidator),
  handler: async (ctx, args) => {
    const ownerId = requireOwner(args.serviceToken);
    const projectKey = cleanRequiredText(args.projectKey, "Project key");
    const limit = boundedLimit(args.limit);
    const now = args.now ?? Date.now();
    const rows =
      args.state === undefined
        ? await ctx.db
            .query("toolActions")
            .withIndex("by_owner_and_project_key", (q) =>
              q.eq("ownerId", ownerId).eq("projectKey", projectKey),
            )
            .order("desc")
            .take(limit)
        : await ctx.db
            .query("toolActions")
            .withIndex("by_owner_and_project_key_and_state", (q) =>
              q.eq("ownerId", ownerId).eq("projectKey", projectKey).eq("state", args.state!),
            )
            .order("desc")
            .take(limit);
    return rows.map((row) => withApprovalExpiryView(row, now));
  },
});

export const approve = mutation({
  args: {
    serviceToken: v.string(),
    projectKey: v.string(),
    actionId: v.string(),
    expectedRevision: v.number(),
    // Optional clock injection for deterministic expiry tests; never read
    // from an untrusted caller in production HTTP callers. A caller-supplied
    // value can only ever shorten (via approvalTtlMs, clamped) the resulting
    // window — it can never extend approval authority, since the ceiling is
    // derived server-side from the proposal's own `destructive` flag.
    now: v.optional(v.number()),
    approvalTtlMs: v.optional(v.number()),
  },
  returns: toolActionDocumentValidator,
  handler: async (ctx, args) => {
    const ownerId = requireOwner(args.serviceToken);
    const projectKey = cleanRequiredText(args.projectKey, "Project key");
    const actionId = cleanRequiredText(args.actionId, "Tool action ID");
    const expectedRevision = requirePositiveRevision(args.expectedRevision, "Expected revision");
    const action = await requireAction(ctx, ownerId, projectKey, actionId);
    const now = args.now ?? Date.now();

    if (action.baseRevision !== expectedRevision) {
      throw new Error(
        `Project revision conflict: expected ${expectedRevision}, proposal base ${action.baseRevision}.`,
      );
    }
    if (action.state === "rejected") {
      throw new Error("Rejected tool actions cannot be approved.");
    }
    if (action.state === "revoked") {
      throw new Error("Revoked tool actions cannot be approved.");
    }
    if (action.state === "expired") {
      throw new Error("Expired tool action approvals cannot be re-approved; restage the action.");
    }

    const project = await requireProject(ctx, ownerId, projectKey);
    if (project.revision !== expectedRevision) {
      throw new Error(
        `Project revision conflict: expected ${expectedRevision}, current ${project.revision}.`,
      );
    }

    if (action.state === "approved") {
      const stillValid =
        action.approvalExpiryPolicy === undefined ||
        !isApprovalExpired(
          { policy: action.approvalExpiryPolicy, expiresAt: action.approvalExpiresAt },
          now,
        );
      if (stillValid) return action;

      // Lazily observed on next touch, matching this repo's no-cron
      // convention. Convex mutations are all-or-nothing transactions — a
      // write followed by a throw in the same call would roll the write
      // back — so this persists the `expired` transition durably and
      // *returns* the now-expired doc rather than throwing, mirroring how
      // reject()'s own idempotent path already returns rather than throws.
      // Callers must check the returned `state`, exactly as they already
      // must for reject()'s idempotent-match case; a caller that blindly
      // treated "no throw" as "still approved" would already be wrong
      // today for that existing case too. The (deferred) HTTP boundary
      // layer is where "not still approved" becomes an actual error
      // response, since only a non-transactional layer can safely convert
      // an already-committed result into a thrown/rejected response.
      const safetyBinding = safetyBindingForAction("tool-approve", action, false);
      await ctx.db.patch("toolActions", action._id, {
        state: "expired",
        expiredObservedAt: now,
        updatedAt: now,
        safetyBinding,
      });
      await appendAudit(ctx, {
        ownerId,
        requestId: action.requestId,
        projectKey,
        eventType: "tool.action.approval-expired",
        actor: "user",
        payload: {
          actionId,
          approvalExpiresAt: action.approvalExpiresAt ?? null,
          observedAt: now,
          safetyBinding,
        },
        createdAt: now,
      });
      const expiredDoc = await ctx.db.get("toolActions", action._id);
      if (!expiredDoc) throw new Error("Tool action expiry observation failed.");
      return expiredDoc;
    }

    const approvalTtlMs = clampApprovalTtlMs(args.approvalTtlMs, action.destructive);
    const safetyBinding = safetyBindingForAction("tool-approve", action, true);
    await ctx.db.patch("toolActions", action._id, {
      state: "approved",
      approvedBy: "user",
      approvedAt: now,
      updatedAt: now,
      approvalExpiryPolicy: "ttl",
      approvalExpiresAt: now + approvalTtlMs,
      consumptionPolicy: deriveConsumptionPolicy(action.destructive),
      safetyBinding,
    });
    await appendAudit(ctx, {
      ownerId,
      requestId: action.requestId,
      projectKey,
      eventType: "tool.action.approved",
      actor: "user",
      payload: {
        actionId,
        baseRevision: action.baseRevision,
        requiredAuthority: action.requiredAuthority,
        destructive: action.destructive,
        safetyBinding,
      },
      createdAt: now,
    });

    const approved = await ctx.db.get("toolActions", action._id);
    if (!approved) throw new Error("Tool action approval failed.");
    return approved;
  },
});

export const reject = mutation({
  args: {
    serviceToken: v.string(),
    projectKey: v.string(),
    actionId: v.string(),
    reason: v.string(),
  },
  returns: toolActionDocumentValidator,
  handler: async (ctx, args) => {
    const ownerId = requireOwner(args.serviceToken);
    const projectKey = cleanRequiredText(args.projectKey, "Project key");
    const actionId = cleanRequiredText(args.actionId, "Tool action ID");
    const reason = cleanRequiredText(args.reason, "Tool action rejection reason");
    const action = await requireAction(ctx, ownerId, projectKey, actionId);

    if (action.state === "approved") {
      throw new Error("Approved tool actions cannot be rejected.");
    }
    if (action.state === "rejected") {
      if (action.rejectedReason === reason) return action;
      throw new Error("Rejected tool action already has a different reason.");
    }

    const now = Date.now();
    await ctx.db.patch("toolActions", action._id, {
      state: "rejected",
      rejectedBy: "user",
      rejectedReason: reason,
      rejectedAt: now,
      updatedAt: now,
    });
    await appendAudit(ctx, {
      ownerId,
      requestId: action.requestId,
      projectKey,
      eventType: "tool.action.rejected",
      actor: "user",
      payload: { actionId, reason },
      createdAt: now,
    });

    const rejected = await ctx.db.get("toolActions", action._id);
    if (!rejected) throw new Error("Tool action rejection failed.");
    return rejected;
  },
});

/**
 * Retracts an already-approved action (R-049). Prospective-only: it stops
 * future execution attempts but cannot and does not claim to undo anything
 * already executed. No `expectedRevision` — unlike approve/stage, revocation
 * doesn't interact with project-revision-scoped conflicts. Deliberately does
 * not delete the action or any audit evidence; it is a state transition, not
 * a destructive record removal.
 */
export const revoke = mutation({
  args: {
    serviceToken: v.string(),
    projectKey: v.string(),
    actionId: v.string(),
    reason: v.string(),
    now: v.optional(v.number()),
  },
  returns: toolActionDocumentValidator,
  handler: async (ctx, args) => {
    const ownerId = requireOwner(args.serviceToken);
    const projectKey = cleanRequiredText(args.projectKey, "Project key");
    const actionId = cleanRequiredText(args.actionId, "Tool action ID");
    const reason = cleanRequiredText(args.reason, "Tool action revocation reason");
    const action = await requireAction(ctx, ownerId, projectKey, actionId);

    if (action.state === "revoked") {
      if (action.revokedReason === reason) return action;
      throw new Error("Tool action already revoked for a different reason.");
    }
    if (action.state !== "approved") {
      throw new Error(
        `Tool action is ${action.state}, not approved; only an approved action can be revoked.`,
      );
    }
    if (
      action.consumptionPolicy === "single-use" &&
      (action.singleUseClaimId !== undefined ||
        (await hasCompletedExecutionReceipt(ctx, ownerId, actionId)))
    ) {
      throw new Error("Tool action is already consumed and cannot be revoked.");
    }

    const now = args.now ?? Date.now();
    const safetyBinding = safetyBindingForAction("tool-revoke", action, true);
    await ctx.db.patch("toolActions", action._id, {
      state: "revoked",
      revokedBy: "user",
      revokedReason: reason,
      revokedAt: now,
      updatedAt: now,
      safetyBinding,
    });
    await appendAudit(ctx, {
      ownerId,
      requestId: action.requestId,
      projectKey,
      eventType: "tool.action.revoked",
      actor: "user",
      payload: { actionId, reason, safetyBinding },
      createdAt: now,
    });

    const revoked = await ctx.db.get("toolActions", action._id);
    if (!revoked) throw new Error("Tool action revocation failed.");
    return revoked;
  },
});

/**
 * The authoritative, atomic single-use execution claim. This is the
 * consumption gate: it must be called and must return `claimed: true`
 * before a single-use action's external effect may be attempted. A
 * read-then-later-write check (e.g. inspecting past receipts) cannot
 * prevent two different-key concurrent executions from both observing "not
 * yet consumed" and both crossing the external-effect boundary — Convex's
 * OCC on this single document is what actually serializes concurrent
 * claims and guarantees exactly one winner. The claim is never released:
 * once set, it stands regardless of the eventual execution outcome
 * (succeeded, failed, or indeterminate), matching this slice's existing
 * "any attempt consumes a single-use action" semantics.
 *
 * Also authoritative for state and expiry, not just claim uniqueness: the
 * caller's decision to attempt execution is made against an earlier,
 * separate, potentially stale read (the HTTP boundary's own `get()`).
 * Revocation or TTL expiry landing on the document between that read and
 * this call would otherwise let a now-revoked or now-expired action's
 * effect still run. `claimed: false` therefore also covers `blockReason:
 * "not-approved"` and `"expired"`, decided from this mutation's own fresh
 * read — never from the caller's stale snapshot.
 */
const singleUseClaimBlockReasonValidator = v.union(
  v.literal("already-claimed"),
  v.literal("not-approved"),
  v.literal("expired"),
  v.literal("omega-mission-not-executable"),
  v.literal("omega-contract-not-authorized"),
  v.literal("omega-contract-expired"),
  v.literal("omega-contract-authority-mismatch"),
  v.literal("omega-precondition-unsatisfied"),
);

const executionEligibilityBlockReasonValidator = v.union(
  v.literal("not-approved"),
  v.literal("expired"),
);

type StateAndExpiryRevision = { ok: true } | { ok: false; blockReason: "not-approved" | "expired" };

/**
 * Authoritative, same-transaction re-check of state/expiry shared by both
 * `claimSingleUseExecution` and `verifyExecutionEligibility`. `action` above
 * is a fresh read, but the caller's own decision to attempt execution was
 * made against a *separate*, potentially stale, earlier read (the HTTP
 * boundary's own `get()`). Revocation or TTL expiry can land on the
 * authoritative document in the gap between that earlier read and this call.
 * A read-before-effect check on stale data cannot catch that — only
 * re-validating state and expiry here, in the same mutation transaction that
 * either claims or clears the action for execution, closes the gap.
 */
async function reviseStateAndExpiryAtExecutionTime(
  ctx: MutationCtx,
  ownerId: string,
  projectKey: string,
  actionId: string,
  action: Doc<"toolActions">,
  now: number,
): Promise<StateAndExpiryRevision> {
  if (action.state !== "approved") {
    return { ok: false, blockReason: "not-approved" };
  }
  if (
    action.approvalExpiryPolicy !== undefined &&
    isApprovalExpired(
      { policy: action.approvalExpiryPolicy, expiresAt: action.approvalExpiresAt },
      now,
    )
  ) {
    // Lazily observed on next touch, matching approve()'s existing
    // lazy-expiry-observation convention: persist the durable `expired`
    // transition rather than merely reporting it, so it becomes true
    // authoritative state, not just a transient read-time computation.
    await ctx.db.patch("toolActions", action._id, {
      state: "expired",
      expiredObservedAt: now,
      updatedAt: now,
    });
    await appendAudit(ctx, {
      ownerId,
      requestId: action.requestId,
      projectKey,
      eventType: "tool.action.approval-expired",
      actor: "tool",
      payload: { actionId, approvalExpiresAt: action.approvalExpiresAt ?? null, observedAt: now },
      createdAt: now,
    });
    return { ok: false, blockReason: "expired" };
  }
  return { ok: true };
}

export const claimSingleUseExecution = mutation({
  args: {
    serviceToken: v.string(),
    projectKey: v.string(),
    actionId: v.string(),
    claimId: v.string(),
    now: v.optional(v.number()),
  },
  returns: v.object({
    claimed: v.boolean(),
    claimId: v.string(),
    blockReason: v.optional(singleUseClaimBlockReasonValidator),
  }),
  handler: async (ctx, args) => {
    const ownerId = requireOwner(args.serviceToken);
    const projectKey = cleanRequiredText(args.projectKey, "Project key");
    const actionId = cleanRequiredText(args.actionId, "Tool action ID");
    const claimId = cleanRequiredText(args.claimId, "Execution claim ID");
    const action = await requireAction(ctx, ownerId, projectKey, actionId);

    if (action.consumptionPolicy !== "single-use") {
      throw new Error("Only single-use actions require an execution claim.");
    }
    if (action.singleUseClaimId !== undefined) {
      return {
        claimed: false,
        claimId: action.singleUseClaimId,
        blockReason: "already-claimed" as const,
      };
    }

    const now = args.now ?? Date.now();
    const revision = await reviseStateAndExpiryAtExecutionTime(
      ctx,
      ownerId,
      projectKey,
      actionId,
      action,
      now,
    );
    if (!revision.ok) {
      return { claimed: false, claimId: "", blockReason: revision.blockReason };
    }

    const omegaDecision = await claimOmegaExecutionContract(ctx, ownerId, action, claimId, now);
    if (!omegaDecision.ok) {
      return { claimed: false, claimId: "", blockReason: omegaDecision.blockReason };
    }

    await ctx.db.patch("toolActions", action._id, {
      singleUseClaimedAt: now,
      singleUseClaimId: claimId,
      updatedAt: now,
    });
    await appendAudit(ctx, {
      ownerId,
      requestId: action.requestId,
      projectKey,
      eventType: "tool.action.execution-claimed",
      actor: "tool",
      payload: { actionId, claimId },
      createdAt: now,
    });
    return { claimed: true, claimId };
  },
});

/**
 * The same authoritative, execute-time freshness guarantee as
 * `claimSingleUseExecution`, for *reusable* (non-single-use) actions — which
 * have nothing to claim (they may legitimately execute more than once) but
 * still need their state/expiry re-verified against the authoritative
 * document immediately before the external effect, not against the caller's
 * earlier, separately-fetched, potentially stale snapshot. Without this, a
 * revoke or TTL expiry landing between that snapshot's fetch and the
 * execute() call would let a reusable action's effect run anyway — the same
 * race `claimSingleUseExecution` closes for single-use actions, previously
 * left open here. (Finding from a full-repo audit, not an independent
 * review comment.)
 */
export const verifyExecutionEligibility = mutation({
  args: {
    serviceToken: v.string(),
    projectKey: v.string(),
    actionId: v.string(),
    now: v.optional(v.number()),
  },
  returns: v.object({
    eligible: v.boolean(),
    blockReason: v.optional(executionEligibilityBlockReasonValidator),
  }),
  handler: async (ctx, args) => {
    const ownerId = requireOwner(args.serviceToken);
    const projectKey = cleanRequiredText(args.projectKey, "Project key");
    const actionId = cleanRequiredText(args.actionId, "Tool action ID");
    const action = await requireAction(ctx, ownerId, projectKey, actionId);

    if (action.consumptionPolicy === "single-use") {
      throw new Error(
        "Single-use actions must use claimSingleUseExecution, not verifyExecutionEligibility.",
      );
    }

    const now = args.now ?? Date.now();
    const revision = await reviseStateAndExpiryAtExecutionTime(
      ctx,
      ownerId,
      projectKey,
      actionId,
      action,
      now,
    );
    if (!revision.ok) {
      return { eligible: false, blockReason: revision.blockReason };
    }
    return { eligible: true };
  },
});
