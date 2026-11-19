import { posix } from "node:path";

import { z } from "zod";

import { canonicalJson } from "../actions/canonicalJson.js";
import { sha256Hex } from "../actions/sha256.js";
import type { ToolAction } from "../actions/toolActions.js";

/**
 * NOLAN trusted autonomy (#839), first slice: a pure, deny-by-default policy
 * evaluator for privileged operations.
 *
 * It decides and never executes. There is no broker, no root process, no
 * shell, and no service or network call here. A later, separately reviewed
 * broker must call this evaluator, then act only on the exact decision (its
 * `bindingDigest`), resolve symlinks itself and refuse if the resolved path
 * differs from the approved one.
 *
 * Authority comes from outside the model:
 * - the operation catalogue and service allowlist are fixed in code;
 * - standing grants are owner-issued, scoped, time-bound and use-limited;
 * - every other privileged operation needs a single-use ToolAction approved by
 *   the user, bound to the exact arguments.
 * The evaluator reads that approval; it never grants or consumes it.
 */

export const PRIVILEGED_POLICY_VERSION = "nolan-privilege-policy:v1";
/** ToolAction `tool` for owner-approved privileged operations. */
export const PRIVILEGED_TOOL = "privileged";

/** Services NOLAN may inspect or restart. Fixed in code, never model-supplied. */
export const PRIVILEGED_SERVICES = ["jarvis.service"] as const;

/** A restart needs an unhealthy observation no older than this. */
export const HEALTH_MAX_AGE_MS = 60_000;
/** At most this many restarts of one service per window, then stop and escalate. */
export const RESTART_RETRY_BUDGET = 3;
export const RESTART_RETRY_WINDOW_MS = 60 * 60_000;

const serviceArgs = z.object({ service: z.enum(PRIVILEGED_SERVICES) }).strict();

/** Absolute, normalised, no `.`/`..` segments, no doubled or trailing slash, no NUL. */
const safeAbsolutePath = z
  .string()
  .max(4096)
  .refine(
    (path) =>
      path.startsWith("/") &&
      path.length > 1 &&
      !path.endsWith("/") &&
      !path.includes("\u0000") &&
      posix.normalize(path) === path,
    "Path must be absolute and normalised.",
  );

/**
 * Closed catalogue. `tier` decides what authority an operation needs; it is
 * never taken from the request.
 */
export const PRIVILEGED_OPERATIONS = Object.freeze({
  "service.status": Object.freeze({ tier: "read", args: serviceArgs }),
  "service.restart": Object.freeze({ tier: "standing_grant", args: serviceArgs }),
  "package.install": Object.freeze({
    tier: "owner_approval",
    args: z
      .object({
        // Must start alphanumeric, so it can never be read as an option.
        packageName: z.string().regex(/^[a-z0-9][a-z0-9+.-]+$/),
        version: z
          .string()
          .regex(/^[0-9A-Za-z][0-9A-Za-z.+:~-]*$/)
          .max(100),
      })
      .strict(),
  }),
  "firewall.change": Object.freeze({
    tier: "owner_approval",
    args: z
      .object({
        action: z.enum(["allow", "deny"]),
        port: z.number().int().min(1).max(65_535),
        protocol: z.enum(["tcp", "udp"]),
        direction: z.enum(["in", "out"]),
      })
      .strict(),
  }),
  "protected_file.write": Object.freeze({
    tier: "owner_approval",
    args: z
      .object({
        path: safeAbsolutePath,
        contentSha256: z.string().regex(/^[0-9a-f]{64}$/),
      })
      .strict(),
  }),
  "maintenance.session": Object.freeze({
    tier: "owner_approval",
    args: z
      .object({
        durationMinutes: z.number().int().min(1).max(120),
        reason: z.string().trim().min(1).max(200),
      })
      .strict(),
  }),
});
export type PrivilegedOperation = keyof typeof PRIVILEGED_OPERATIONS;
export type PrivilegeTier = (typeof PRIVILEGED_OPERATIONS)[PrivilegedOperation]["tier"];

const isoTimestamp = z
  .string()
  .refine((value) => /T/.test(value) && Number.isFinite(Date.parse(value)), "Expected ISO time.");

export const standingGrantSchema = z
  .object({
    grantId: z.string().trim().min(1).max(200),
    /** Only standing-grant-tier operations can be granted. */
    operation: z.literal("service.restart"),
    service: z.enum(PRIVILEGED_SERVICES),
    approvedBy: z.literal("owner"),
    /** Owner decision that issued the grant. */
    approvalRef: z.string().trim().min(1).max(200),
    issuedAt: isoTimestamp,
    expiresAt: isoTimestamp,
    maxUses: z.number().int().min(1).max(10),
  })
  .strict();
export type StandingGrant = z.infer<typeof standingGrantSchema>;

export type HaltState = "none" | "requested" | "acknowledged" | "verified_stopped";

export type ServiceHealthObservation = {
  service: (typeof PRIVILEGED_SERVICES)[number];
  state: "healthy" | "unhealthy" | "unknown";
  observedAt: string;
};

/** State the caller observed. The evaluator trusts none of it without checking. */
export type PrivilegeContext = {
  now: string;
  halt: HaltState;
  /** Request IDs already decided; a repeat is a replay. */
  seenRequestIds: readonly string[];
  grant?: StandingGrant;
  /** Uses already recorded against `grant`. */
  grantUses?: number;
  approval?: ToolAction;
  health?: ServiceHealthObservation;
  /** Times of earlier restart attempts for the requested service. */
  recentRestarts?: readonly string[];
};

const contextSchema = z.object({
  now: isoTimestamp,
  halt: z.enum(["none", "requested", "acknowledged", "verified_stopped"]),
  seenRequestIds: z.array(z.string()),
  grantUses: z.number().int().min(0).optional(),
  recentRestarts: z.array(isoTimestamp).optional(),
});

const requestSchema = z
  .object({
    requestId: z.string().trim().min(1).max(200),
    operation: z.string(),
    args: z.unknown(),
  })
  .strict();

const healthSchema = z
  .object({
    service: z.enum(PRIVILEGED_SERVICES),
    state: z.enum(["healthy", "unhealthy", "unknown"]),
    observedAt: isoTimestamp,
  })
  .strict();

export type PrivilegeDenialReason =
  | "invalid_request"
  | "invalid_context"
  | "unknown_operation"
  | "invalid_arguments"
  | "halted"
  | "replayed_request"
  | "standing_grant_required"
  | "grant_invalid"
  | "grant_scope_mismatch"
  | "grant_expired"
  | "grant_exhausted"
  | "health_unknown"
  | "health_stale"
  | "no_failure_observed"
  | "retry_budget_exhausted"
  | "owner_approval_required"
  | "approval_expired"
  | "approval_mismatch";

export type PrivilegeDecision =
  | {
      allowed: true;
      operation: PrivilegedOperation;
      tier: PrivilegeTier;
      args: Record<string, unknown>;
      /** Grant ID, ToolAction ID, or "read-only". */
      authorityRef: string;
      policyVersion: typeof PRIVILEGED_POLICY_VERSION;
      /** SHA-256 over the exact decision; a broker must act on this and nothing wider. */
      bindingDigest: string;
    }
  | { allowed: false; reason: PrivilegeDenialReason };

function deny(reason: PrivilegeDenialReason): PrivilegeDecision {
  return { allowed: false, reason };
}

function isOperation(value: string): value is PrivilegedOperation {
  return Object.prototype.hasOwnProperty.call(PRIVILEGED_OPERATIONS, value);
}

function checkGrant(
  grant: unknown,
  uses: number,
  operation: PrivilegedOperation,
  args: Record<string, unknown>,
  now: number,
): PrivilegeDenialReason | { grantId: string } {
  if (grant === undefined) return "standing_grant_required";
  const parsed = standingGrantSchema.safeParse(grant);
  if (!parsed.success) return "grant_invalid";
  const valid = parsed.data;
  if (Date.parse(valid.issuedAt) > now) return "grant_invalid";
  if (valid.operation !== operation || valid.service !== args.service) {
    return "grant_scope_mismatch";
  }
  if (!(Date.parse(valid.expiresAt) > now)) return "grant_expired";
  if (uses >= valid.maxUses) return "grant_exhausted";
  return { grantId: valid.grantId };
}

/** A restart is verified recovery, not a reflex: fresh failure evidence and a budget. */
function checkRestartPreconditions(
  health: unknown,
  recentRestarts: readonly string[],
  service: unknown,
  now: number,
): PrivilegeDenialReason | null {
  if (health === undefined) return "health_unknown";
  const parsed = healthSchema.safeParse(health);
  if (!parsed.success || parsed.data.service !== service) return "health_unknown";
  const observedAt = Date.parse(parsed.data.observedAt);
  if (observedAt > now || now - observedAt > HEALTH_MAX_AGE_MS) return "health_stale";
  if (parsed.data.state === "unknown") return "health_unknown";
  if (parsed.data.state === "healthy") return "no_failure_observed";
  const inWindow = recentRestarts.filter((at) => {
    const time = Date.parse(at);
    // A future-dated attempt still counts: clock skew must not reopen the budget.
    return now - time < RESTART_RETRY_WINDOW_MS;
  });
  if (inWindow.length >= RESTART_RETRY_BUDGET) return "retry_budget_exhausted";
  return null;
}

function checkApproval(
  action: ToolAction | undefined,
  requestId: string,
  operation: PrivilegedOperation,
  args: Record<string, unknown>,
  now: number,
): PrivilegeDenialReason | { actionId: string } {
  if (
    action === undefined ||
    action.state !== "approved" ||
    action.approvedBy !== "user" ||
    action.consumptionPolicy !== "single-use"
  ) {
    return "owner_approval_required";
  }
  if (
    action.isApprovalExpired === true ||
    (action.approvalExpiresAt !== undefined && !(Date.parse(action.approvalExpiresAt) > now))
  ) {
    return "approval_expired";
  }
  if (action.tool !== PRIVILEGED_TOOL || action.operation !== operation) return "approval_mismatch";
  // The approval authorises one request, not every request with equal arguments.
  if (action.requestId !== requestId) return "approval_mismatch";
  let bound: string;
  try {
    bound = canonicalJson(action.arguments);
  } catch {
    return "approval_mismatch";
  }
  if (bound !== canonicalJson(args)) return "approval_mismatch";
  return { actionId: action.actionId };
}

/**
 * Evaluates one privileged request. Checks run in a fixed order and the first
 * failure denies: request shape, context, operation, arguments, halt, replay,
 * then the authority its tier requires.
 */
export function evaluatePrivilegedOperation(
  request: unknown,
  context: PrivilegeContext,
): PrivilegeDecision {
  const parsedRequest = requestSchema.safeParse(request);
  if (!parsedRequest.success) return deny("invalid_request");
  const parsedContext = contextSchema.safeParse(context);
  if (!parsedContext.success) return deny("invalid_context");
  const { requestId, operation } = parsedRequest.data;
  const now = Date.parse(parsedContext.data.now);

  if (!isOperation(operation)) return deny("unknown_operation");
  const spec = PRIVILEGED_OPERATIONS[operation];
  const parsedArgs = spec.args.safeParse(parsedRequest.data.args);
  if (!parsedArgs.success) return deny("invalid_arguments");
  const args = parsedArgs.data as Record<string, unknown>;

  // A halt blocks every new dispatch; read-only inspection stays available.
  if (spec.tier !== "read" && parsedContext.data.halt !== "none") return deny("halted");
  if (parsedContext.data.seenRequestIds.includes(requestId)) return deny("replayed_request");

  let authorityRef = "read-only";
  if (spec.tier === "standing_grant") {
    // The use count and restart history must be supplied, never assumed empty.
    if (
      (context.grant !== undefined && parsedContext.data.grantUses === undefined) ||
      parsedContext.data.recentRestarts === undefined
    ) {
      return deny("invalid_context");
    }
    const grant = checkGrant(
      context.grant,
      parsedContext.data.grantUses ?? 0,
      operation,
      args,
      now,
    );
    if (typeof grant === "string") return deny(grant);
    const blocked = checkRestartPreconditions(
      context.health,
      parsedContext.data.recentRestarts,
      args.service,
      now,
    );
    if (blocked) return deny(blocked);
    authorityRef = grant.grantId;
  } else if (spec.tier === "owner_approval") {
    // Standing grants never apply here, so they cannot escalate.
    const approved = checkApproval(context.approval, requestId, operation, args, now);
    if (typeof approved === "string") return deny(approved);
    authorityRef = approved.actionId;
  }

  return {
    allowed: true,
    operation,
    tier: spec.tier,
    args,
    authorityRef,
    policyVersion: PRIVILEGED_POLICY_VERSION,
    bindingDigest: sha256Hex(
      canonicalJson({
        policyVersion: PRIVILEGED_POLICY_VERSION,
        requestId,
        operation,
        args,
        authorityRef,
      }),
    ),
  };
}
