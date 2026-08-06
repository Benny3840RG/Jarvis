import assert from "node:assert/strict";
import { describe, it } from "node:test";

import {
  IMMUTABLE_SAFETY_CATEGORIES,
  bindSafety,
  type SafetyBindingInput,
  type SafetyPhase,
} from "../src/safety/safetyBinder.js";

const phases: readonly SafetyPhase[] = [
  "reasoning",
  "memory-proposal",
  "memory-apply",
  "tool-stage",
  "tool-approve",
  "tool-revoke",
  "tool-execute",
  "tool-reconcile",
];

function inputFor(phase: SafetyPhase): SafetyBindingInput {
  const memory = phase === "memory-proposal" || phase === "memory-apply";
  const tool = phase.startsWith("tool-");
  return {
    phase,
    riskLevel: "low",
    domainBound: true,
    crossDomain: false,
    memoryRequired: memory,
    memorySafe: memory ? true : undefined,
    reliabilityRequired: tool || memory,
    reliabilityHealthy: tool || memory,
    proposalSafe:
      phase === "reasoning" ||
      phase === "memory-proposal" ||
      phase === "tool-stage" ||
      phase === "tool-approve",
    toolAllowlisted: tool,
    requiredAuthority: tool ? "T1" : undefined,
    grantedAuthority: tool ? "T3" : undefined,
    actionState: tool ? "execute" : "propose",
    requiresApproval: tool && phase !== "tool-revoke",
    approvalPresent: tool,
    externalEffect: phase === "tool-execute",
    idempotencyKey: tool || memory ? `idempotency-${phase}` : undefined,
    correlationId: tool || memory ? `correlation-${phase}` : undefined,
    stateValid: true,
    outcome: "pending",
    recoveryAvailable: phase === "tool-execute",
  };
}

describe("safety category transition matrix", () => {
  it("binds all six categories across every governed transition phase", () => {
    for (const phase of phases) {
      const result = bindSafety(inputFor(phase));
      assert.equal(result.status, "pass", phase);
      assert.deepEqual(
        result.categories.map((category) => category.category),
        IMMUTABLE_SAFETY_CATEGORIES,
        phase,
      );
      assert.ok(
        result.categories.every((category) => category.reasons.length === 0),
        phase,
      );
    }
  });

  it("fails closed when a governed transition omits its required category evidence", () => {
    for (const phase of phases) {
      const input = inputFor(phase);
      const missingEvidence: SafetyBindingInput = {
        ...input,
        ...(phase === "memory-proposal" || phase === "memory-apply"
          ? { memorySafe: undefined }
          : {}),
        ...(phase.startsWith("tool-")
          ? { toolAllowlisted: undefined, reliabilityHealthy: undefined }
          : {}),
        ...(phase === "reasoning" ? { proposalSafe: undefined } : {}),
      };
      const result = bindSafety(missingEvidence);
      assert.equal(result.status, "blocked", phase);
    }
  });
});
