/**
 * ACP consultation wiring (roadmap PR H, slice 6 — the live path, dormant-first).
 *
 * Composes the pieces built in earlier slices into a single consultation entry
 * point: resolve the worker launch config from the environment
 * ({@link resolveAcpWorkerConfigFromEnv}), and — only when a worker is
 * configured *and* `consult()` is actually called — launch it via
 * {@link spawnAcpChild} behind a {@link StdioAcpTransport} and route the answer
 * through the fail-closed AUTH-INV-05 gate ({@link consultAcpPeer}).
 *
 * Dormant-first: constructing this launches nothing. No process starts until the
 * env is provisioned AND a caller invokes `consult()`. Nothing in the governed
 * execution path calls it yet; this slice delivers the ready path, not a change
 * to live authority behaviour.
 *
 * Semantics:
 *   - **No worker configured** (the advisory ACP overlay is off): by default the
 *     governed approval alone decides — ACP is advisory, and its absence must not
 *     block normal governed-approved work. Set `requireConfiguredPeer` to make
 *     ACP mandatory, in which case an unconfigured consult fails closed (blocked).
 *   - **Worker configured**: the peer is consulted; a valid `allow` still needs
 *     governed approval, a `deny` vetoes, and a failed/invalid consultation
 *     (crash, timeout, flood, malformed, mismatched) is indeterminate and blocks
 *     even with governed approval — a hostile/broken worker can neither
 *     manufacture an `allow` nor suppress a veto.
 *
 * The worker is launched with a minimal, credential-free environment
 * (see {@link spawnAcpChild} / `buildAcpChildEnv`); its own model/API egress is a
 * separate governed concern (see `docs/operations/acp-worker-sandbox.md`) that
 * this slice neither grants nor broadens.
 */

import type { AcpAuthorizationOutcome } from "./acpContract.js";
import {
  spawnAcpChild,
  StdioAcpTransport,
  type AcpChildProcess,
  type AcpWorkerConfig,
} from "./acpStdioTransport.js";
import { consultAcpPeer, type AcpPermissionRequest } from "./acpTransport.js";
import { resolveAcpWorkerConfigFromEnv } from "./acpWorkerConfig.js";

/** A ready ACP consultation path. `enabled` reflects whether a peer is configured. */
export type AcpConsultation = Readonly<{
  enabled: boolean;
  consult(
    request: AcpPermissionRequest,
    governedApprovalPresent: boolean,
  ): Promise<AcpAuthorizationOutcome>;
}>;

export type AcpConsultationDeps = Readonly<{
  environment?: Readonly<Record<string, string | undefined>>;
  prefix?: string;
  /** Whether ACP is mandatory: if true and no peer is configured, consult blocks. */
  requireConfiguredPeer?: boolean;
  /** Build a child from resolved config (default {@link spawnAcpChild}); injected in tests. */
  spawnChild?: (config: AcpWorkerConfig) => AcpChildProcess;
  timeoutMs?: number;
  maxResponseLines?: number;
  /** Injectable timeout scheduler (tests); defaults to the transport's own. */
  scheduleTimeout?: (handler: () => void, ms: number) => () => void;
}>;

/**
 * Build the ACP consultation path from the environment. Launches nothing here;
 * a worker is spawned only inside `consult()` when a peer is configured.
 */
export function createAcpConsultationFromEnv(deps: AcpConsultationDeps = {}): AcpConsultation {
  const config = resolveAcpWorkerConfigFromEnv(deps.environment, { prefix: deps.prefix });

  if (!config) {
    const requireConfiguredPeer = deps.requireConfiguredPeer ?? false;
    return {
      enabled: false,
      async consult(_request, governedApprovalPresent) {
        if (requireConfiguredPeer) {
          return {
            authorised: false,
            reason:
              "ACP consultation is required but no worker peer is configured; blocked (fail-closed).",
          };
        }
        return {
          authorised: governedApprovalPresent,
          reason:
            "ACP peer not configured; the advisory ACP overlay is disabled, so the governed approval alone decides.",
        };
      },
    };
  }

  const spawnChild = deps.spawnChild ?? ((c: AcpWorkerConfig) => spawnAcpChild(c));
  return {
    enabled: true,
    async consult(request, governedApprovalPresent) {
      const transport = new StdioAcpTransport({
        spawn: () => spawnChild(config),
        timeoutMs: deps.timeoutMs,
        maxResponseLines: deps.maxResponseLines,
        scheduleTimeout: deps.scheduleTimeout,
      });
      return consultAcpPeer({ transport, request, governedApprovalPresent });
    },
  };
}
