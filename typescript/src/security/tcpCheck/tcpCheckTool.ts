// Governed tool definition for `security:tcp-check` (design: Architecture; #779
// Phase 4). Declares the T3 external-effect operation, its strict argument
// schema, the read-only preflight gate (Phase 1 checks, no single-use
// consumption), and the execute path that records the provider attempt identity
// before the effect and emits a digest-only result. Registration into the live
// tool-execution service is deliberately omitted: the capability is `planned`
// (see createTcpCheckProviderFromEnv), so externalProviderFor never resolves it
// until commissioning under separate owner approval.

import { z } from "zod";

import {
  ToolExecutionPreconditionError,
  type ToolExecutionContext,
  type ToolExecutionDefinition,
} from "../../actions/toolExecution.js";

import { parseCanonicalAddress } from "./address.js";
import { isAllowlisted, MAX_PORT, MIN_PORT } from "./allowlist.js";
import type { PolicyView } from "./enforcer.js";
import { evaluateFreshness } from "./freshness.js";
import { isSpecialUse, verifySpecialUseTable } from "./specialUseTable.js";
import type { TcpCheckProvider } from "./tcpCheckProvider.js";

export const SECURITY_TOOL = "security";
export const TCP_CHECK_OPERATION = "tcp-check";

/**
 * Strict argument schema: a canonical IP literal and an integer port 1–65535.
 * The `ip` field is deliberately NOT trimmed — trimming would rewrite a
 * whitespace-padded input (e.g. `" 8.8.8.8 "`) into a canonical one and accept
 * it, violating the design's "reject, never rewrite" rule. The untrimmed value
 * is handed to `parseCanonicalAddress`, which rejects any surrounding
 * whitespace as non-canonical.
 */
export const tcpCheckArgumentsSchema = z
  .object({
    ip: z.string().min(1).max(45),
    port: z.number().int().min(MIN_PORT).max(MAX_PORT),
  })
  .strict();

export type TcpCheckArguments = z.infer<typeof tcpCheckArgumentsSchema>;

/**
 * Run the deterministic, read-only policy gate (design R2/R3; Phase 1). A
 * rejection here is a precondition failure, so it does not exercise a single-use
 * approval. The table integrity anchor is verified first (fail-closed deny-all),
 * then the target must be canonical, non-special-use, allowlisted, and the
 * snapshot fresh.
 */
function assertTargetAdmissible(
  parsed: TcpCheckArguments,
  policy: PolicyView,
  nowMs: number,
): void {
  verifySpecialUseTable(); // throws fail-closed on anchor mismatch
  const address = parseCanonicalAddress(parsed.ip);
  if (address === null) {
    throw new ToolExecutionPreconditionError("target is not a canonical IP literal");
  }
  if (isSpecialUse(address)) {
    throw new ToolExecutionPreconditionError("target is a special-use address and is denied");
  }
  if (!isAllowlisted(policy.allowlist, parsed.ip, parsed.port)) {
    throw new ToolExecutionPreconditionError("target is not in the active allowlist");
  }
  if (
    !evaluateFreshness({ snapshotDate: policy.snapshotDate, nowMs, maxAgeMs: policy.maxAgeMs })
      .fresh
  ) {
    throw new ToolExecutionPreconditionError("special-use table snapshot is not fresh");
  }
}

/**
 * Build the `security:tcp-check` tool definition. `externalProvider` names the
 * egress-mediator provider, `minimumAuthority` is T3 (external/destructive
 * class), and the effect is emitted only through the provider.
 */
export function createTcpCheckToolDefinition(
  provider: TcpCheckProvider,
  policy: () => PolicyView,
  clock: () => number = () => Date.now(),
): ToolExecutionDefinition {
  return {
    tool: SECURITY_TOOL,
    operation: TCP_CHECK_OPERATION,
    externalProvider: provider.name,
    minimumAuthority: "T3",
    schema: tcpCheckArgumentsSchema,
    async preflight(argumentsValue): Promise<void> {
      const parsed = tcpCheckArgumentsSchema.parse(argumentsValue);
      assertTargetAdmissible(parsed, policy(), clock());
    },
    async execute(argumentsValue, _signal, context: ToolExecutionContext): Promise<unknown> {
      const parsed = tcpCheckArgumentsSchema.parse(argumentsValue);
      // Re-run the deterministic gate immediately before the effect.
      assertTargetAdmissible(parsed, policy(), clock());

      const attempt = await provider.prepare(
        { ip: parsed.ip, port: parsed.port },
        {
          // Owner is the project owner; the admission slot is owner-wide.
          owner: context.action.projectId,
          project: context.action.projectId,
          // exact_action_fingerprint: binds the approval to exactly this action.
          actionFingerprint: context.effectFingerprint,
          correlationId: context.correlationId,
        },
      );

      // Record the attempt identity before the effect crosses the boundary.
      await context.registerProviderAttempt({
        provider: provider.name,
        providerRequestId: attempt.providerRequestId,
        providerCorrelationId: attempt.providerCorrelationId,
      });

      return provider.sendPrepared(attempt, { ip: parsed.ip, port: parsed.port });
    },
  };
}
