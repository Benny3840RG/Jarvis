import type {
  DomainResult,
  OrchestrationCommand,
  OrchestrationContext,
  OrchestrationExecutor,
} from "../../orchestration/contracts.js";
import { COMMISSIONING_PROBE_OPERATION_ID } from "./policy.js";

/**
 * The only executor the isolated-ingress commissioning bootstrap composes.
 *
 * It handles exactly one command — `commissioningProbe` — as a pure function:
 * it echoes the nonce and reads an injected clock. It constructs no persistence
 * provider, store, HTTP client or any other business-effect adapter. Every
 * other command is refused, so a misconfigured graph cannot smuggle a real
 * operation through this composition.
 */
export function createCommissioningProbeExecutor(
  now: () => number = () => Date.now(),
): OrchestrationExecutor {
  return {
    async execute(
      command: OrchestrationCommand,
      _context: OrchestrationContext,
    ): Promise<DomainResult> {
      if (command.operationId !== COMMISSIONING_PROBE_OPERATION_ID) {
        return {
          ok: false,
          code: "blocked",
          message: `The commissioning composition executes only ${COMMISSIONING_PROBE_OPERATION_ID}, not ${command.operationId}.`,
          retryable: false,
        };
      }
      const nonce = command.input.nonce;
      if (typeof nonce !== "string" || nonce.length === 0) {
        return {
          ok: false,
          code: "invalid_request",
          message: "The commissioning probe requires a non-empty nonce.",
          retryable: false,
        };
      }
      return {
        ok: true,
        value: { probe: "ok", nonce, observedAt: now() },
      };
    },
  };
}
