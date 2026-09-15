import type { OrchestrationSafetyGate, SafetyDecision } from "../../orchestration/runner.js";
import { COMMISSIONING_PROBE_OPERATION_ID } from "./policy.js";

const OK: SafetyDecision = { status: "ok", reasons: [] };

/**
 * Safety gate for the isolated-ingress commissioning composition. It admits the
 * read-only `commissioningProbe` and nothing else; any other operation is
 * blocked before it can reach the executor. A read-only probe with no external
 * effect does not need the full `bindSafety` binding (`src/safety/safetyBinder.ts`).
 */
export function createCommissioningSafetyGate(): OrchestrationSafetyGate {
  return {
    async preflight({ node }): Promise<SafetyDecision> {
      if (node.command.operationId !== COMMISSIONING_PROBE_OPERATION_ID) {
        return {
          status: "blocked",
          reasons: [
            `Commissioning safety admits only ${COMMISSIONING_PROBE_OPERATION_ID}, not ${node.command.operationId}.`,
          ],
        };
      }
      return OK;
    },
    async postflight(): Promise<SafetyDecision> {
      return OK;
    },
  };
}
