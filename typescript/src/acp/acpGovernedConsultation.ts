/**
 * Governed ACP consultation (roadmap PR H — governed commissioning slice).
 *
 * The seam a governed decision site calls to obtain ACP *evidence and, in
 * `required` mode, an authority-reducing veto*. It composes three lower layers
 * without weakening any of them:
 *
 *   1. worker launch config from the environment (`resolveAcpWorkerConfigFromEnv`);
 *   2. the stdio transport + a per-request child (`StdioAcpTransport` /
 *      `spawnAcpChild`) — dormant-first: nothing launches until `consult()` is
 *      actually called *and* a mode is active *and* a worker is configured;
 *   3. the pure operating-mode policy (`resolveAcpModePolicy`).
 *
 * The result is structured {@link AcpConsultationEvidence}: what the peer said
 * (classified into the failure taxonomy), whether execution may proceed, and
 * whether a disagreement was recorded. Authority is *never* created here — the
 * governed approval is an input decided elsewhere, and this layer can only leave
 * it intact (advisory) or reduce it (required veto/failure).
 *
 * Fail-closed sequencing (see `resolveAcpModePolicy` for the matrices):
 *   - `disabled` → never consults; the governed decision stands.
 *   - no governed approval → blocks *without consulting* (ACP cannot grant
 *     authority, so a doomed action never launches a worker).
 *   - active mode + governed approval + no worker configured → `unavailable`
 *     (advisory records and proceeds; required blocks).
 *   - active mode + governed approval + worker configured → the peer is
 *     consulted and classified.
 */

import type { AcpPermissionResponse } from "./acpContract.js";
import {
  resolveAcpModePolicy,
  resolveAcpOperatingModeFromEnv,
  type AcpConsultationClassification,
  type AcpOperatingMode,
} from "./acpOperatingMode.js";
import {
  AcpStdioTransportError,
  spawnAcpChild,
  StdioAcpTransport,
  type AcpChildProcess,
  type AcpWorkerConfig,
} from "./acpStdioTransport.js";
import type { AcpPermissionRequest, AcpTransport } from "./acpTransport.js";
import { resolveAcpWorkerConfigFromEnv } from "./acpWorkerConfig.js";

/** Structured, non-secret record of one governed consultation. Observability + evidence. */
export type AcpConsultationEvidence = Readonly<{
  mode: AcpOperatingMode;
  /** `${tool}:${operation}` (or the caller's action label). */
  action: string;
  requestId: string;
  correlationId?: string;
  /** The server-derived governed approval fact fed in by the caller. */
  governedApprovalPresent: boolean;
  /** Whether a peer was actually consulted (a worker launched or transport used). */
  consulted: boolean;
  /** The classified consultation result; absent when no peer was consulted. */
  classification?: AcpConsultationClassification;
  /** Whether the governed execution may proceed. */
  proceed: boolean;
  /** True only for an advisory `deny` that proceeded: a recorded disagreement. */
  disagreement: boolean;
  reason: string;
  /** Wall-clock consultation latency in ms, when a peer was consulted. */
  latencyMs?: number;
}>;

/** A ready governed consultation path. `mode` reflects the resolved operating mode. */
export type GovernedAcpConsultation = Readonly<{
  mode: AcpOperatingMode;
  consult(
    request: AcpPermissionRequest,
    governedApprovalPresent: boolean,
  ): Promise<AcpConsultationEvidence>;
}>;

export type GovernedAcpConsultationDeps = Readonly<{
  environment?: Readonly<Record<string, string | undefined>>;
  /** Env prefix for the worker command/args (default `JARVIS_ACP_WORKER`). */
  prefix?: string;
  /** Env key for the operating mode (default `JARVIS_ACP_MODE`). */
  modeKey?: string;
  /** Override the resolved mode (tests); otherwise read from the environment. */
  mode?: AcpOperatingMode;
  /** Build a child from resolved config (default {@link spawnAcpChild}); injected in tests. */
  spawnChild?: (config: AcpWorkerConfig) => AcpChildProcess;
  timeoutMs?: number;
  maxResponseLines?: number;
  scheduleTimeout?: (handler: () => void, ms: number) => () => void;
  /** Monotonic-ish clock for latency (default {@link Date.now}); injectable in tests. */
  now?: () => number;
}>;

/**
 * Validate a raw transport answer and classify it, fail-closed. A well-formed
 * matching decision returns `allow`/`deny`/`abstain`; anything else is a failure
 * classification. Reading a hostile object's getters can throw — caught as
 * `malformed_response`.
 */
function classifyResponse(
  raw: unknown,
  request: AcpPermissionRequest,
): AcpConsultationClassification {
  try {
    if (typeof raw !== "object" || raw === null) return "malformed_response";
    const candidate = raw as AcpPermissionResponse;
    if (candidate.requestId !== request.requestId) return "request_mismatch";
    const decision = candidate.decision;
    if (decision === "allow" || decision === "deny" || decision === "abstain") return decision;
    return "malformed_response";
  } catch {
    return "malformed_response";
  }
}

/** Map a thrown consultation error to a failure classification. Never throws. */
function classifyError(error: unknown): AcpConsultationClassification {
  if (error instanceof AcpStdioTransportError) {
    switch (error.code) {
      case "timeout":
        return "timeout";
      case "worker_crash":
        return "worker_crash";
      case "output_limit_exceeded":
        return "output_limit_exceeded";
      case "request_mismatch":
        return "request_mismatch";
      case "write_failed":
        return "internal_transport_error";
    }
  }
  // Any other throw is unclassifiable: per the declared taxonomy, conservatively
  // `internal_transport_error` (NOT `unavailable`, which is reserved for a peer
  // that could not be reached at all — e.g. no worker configured, synthesised by
  // the caller). Both fail closed identically in required mode; the distinction
  // is for accurate operational evidence.
  return "internal_transport_error";
}

/**
 * Consult a transport and classify the outcome. Never throws: a rejection or an
 * invalid answer becomes a failure classification, never authority.
 */
export async function classifyAcpConsultation(
  transport: AcpTransport,
  request: AcpPermissionRequest,
): Promise<AcpConsultationClassification> {
  try {
    const raw = await transport.requestPermission(request);
    return classifyResponse(raw, request);
  } catch (error: unknown) {
    return classifyError(error);
  }
}

/**
 * Build the governed ACP consultation from the environment. Dormant-first:
 * constructing it launches nothing and, in `disabled` mode (the default), never
 * will. A worker is spawned only inside `consult()` when the mode is active, a
 * governed approval is present, and a worker is configured.
 */
export function createGovernedAcpConsultationFromEnv(
  deps: GovernedAcpConsultationDeps = {},
): GovernedAcpConsultation {
  const mode = deps.mode ?? resolveAcpOperatingModeFromEnv(deps.environment, { key: deps.modeKey });
  const config = resolveAcpWorkerConfigFromEnv(deps.environment, { prefix: deps.prefix });
  const spawnChild = deps.spawnChild ?? ((c: AcpWorkerConfig) => spawnAcpChild(c));
  const now = deps.now ?? (() => Date.now());

  const evidence = (
    request: AcpPermissionRequest,
    governedApprovalPresent: boolean,
    consulted: boolean,
    classification: AcpConsultationClassification | undefined,
    latencyMs: number | undefined,
  ): AcpConsultationEvidence => {
    const policy = resolveAcpModePolicy({ mode, governedApprovalPresent, classification });
    return {
      mode,
      action: request.action,
      requestId: request.requestId,
      ...(request.detail === undefined ? {} : { correlationId: request.detail }),
      governedApprovalPresent,
      consulted,
      ...(classification === undefined ? {} : { classification }),
      proceed: policy.proceed,
      disagreement: policy.disagreement,
      reason: policy.reason,
      ...(latencyMs === undefined ? {} : { latencyMs }),
    };
  };

  return {
    mode,
    async consult(request, governedApprovalPresent) {
      // Disabled: never consult. Governed decision stands.
      if (mode === "disabled") {
        return evidence(request, governedApprovalPresent, false, undefined, undefined);
      }
      // ACP can never grant authority: an unauthorised action never launches a
      // worker and is blocked before any consultation.
      if (!governedApprovalPresent) {
        return evidence(request, false, false, undefined, undefined);
      }
      // Active mode + governed approval, but no reachable peer: unavailable.
      if (!config) {
        return evidence(request, true, false, "unavailable", undefined);
      }
      // Active mode + governed approval + configured worker: consult and classify.
      const transport: AcpTransport = new StdioAcpTransport({
        spawn: () => spawnChild(config),
        timeoutMs: deps.timeoutMs,
        maxResponseLines: deps.maxResponseLines,
        scheduleTimeout: deps.scheduleTimeout,
      });
      const startedAt = now();
      const classification = await classifyAcpConsultation(transport, request);
      const latencyMs = Math.max(0, now() - startedAt);
      return evidence(request, true, true, classification, latencyMs);
    },
  };
}
