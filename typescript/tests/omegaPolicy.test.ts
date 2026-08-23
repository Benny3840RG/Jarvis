import assert from "node:assert/strict";
import test from "node:test";

import {
  canTransitionOmegaMission,
  evaluateOmegaCompletion,
  riskRequiresIndependentValidation,
} from "../src/omega/policy.js";

function passingProof(criterionId = "AC-1", independent = false) {
  return {
    criterionId,
    result: "pass" as const,
    independent,
    evidenceRefs: ["EV-1"],
  };
}

test("forbids blocked -> complete shortcut", () => {
  assert.equal(canTransitionOmegaMission("blocked", "complete"), false);
});

test("forbids blocked -> active through the generic transition policy", () => {
  assert.equal(canTransitionOmegaMission("blocked", "active"), false);
});

test("requires at least one acceptance criterion", () => {
  const decision = evaluateOmegaCompletion({
    criteria: [],
    proofs: [],
    riskClass: "R1",
    unresolvedCriticalContradictions: 0,
    unreconciledExternalEffects: 0,
    residualUncertainty: 0,
    uncertaintyBudget: 0.2,
  });
  assert.equal(decision.allowed, false);
  assert.ok(decision.failures.includes("no-acceptance-criteria"));
});

test("requires a passing proof for every criterion", () => {
  const decision = evaluateOmegaCompletion({
    criteria: [{ criterionId: "AC-1" }],
    proofs: [],
    riskClass: "R1",
    unresolvedCriticalContradictions: 0,
    unreconciledExternalEffects: 0,
    residualUncertainty: 0.1,
    uncertaintyBudget: 0.2,
  });
  assert.equal(decision.allowed, false);
  assert.ok(decision.failures.includes("criterion-missing-passing-proof:AC-1"));
});

test("rejects proofs for unknown criteria", () => {
  const decision = evaluateOmegaCompletion({
    criteria: [{ criterionId: "AC-1" }],
    proofs: [passingProof("AC-404", true)],
    riskClass: "R1",
    unresolvedCriticalContradictions: 0,
    unreconciledExternalEffects: 0,
    residualUncertainty: 0.1,
    uncertaintyBudget: 0.2,
  });
  assert.equal(decision.allowed, false);
  assert.ok(decision.failures.includes("validation-proof-unknown-criterion"));
});

test("rejects passing proofs without evidence", () => {
  const decision = evaluateOmegaCompletion({
    criteria: [{ criterionId: "AC-1" }],
    proofs: [
      {
        criterionId: "AC-1",
        result: "pass",
        independent: false,
        evidenceRefs: [],
      },
    ],
    riskClass: "R1",
    unresolvedCriticalContradictions: 0,
    unreconciledExternalEffects: 0,
    residualUncertainty: 0.1,
    uncertaintyBudget: 0.2,
  });
  assert.equal(decision.allowed, false);
  assert.ok(decision.failures.includes("passing-proof-missing-evidence"));
});

test("current failed validation remains fail-closed", () => {
  const decision = evaluateOmegaCompletion({
    criteria: [{ criterionId: "AC-1" }],
    proofs: [
      passingProof(),
      {
        criterionId: "AC-1",
        result: "fail",
        independent: false,
        evidenceRefs: ["EV-1"],
      },
    ],
    riskClass: "R1",
    unresolvedCriticalContradictions: 0,
    unreconciledExternalEffects: 0,
    residualUncertainty: 0.1,
    uncertaintyBudget: 0.2,
  });
  assert.equal(decision.allowed, false);
  assert.ok(decision.failures.includes("validation-proof-failed"));
});

test("denies completion with unresolved critical contradictions", () => {
  const decision = evaluateOmegaCompletion({
    criteria: [{ criterionId: "AC-1" }],
    proofs: [passingProof()],
    riskClass: "R1",
    unresolvedCriticalContradictions: 1,
    unreconciledExternalEffects: 0,
    residualUncertainty: 0.1,
    uncertaintyBudget: 0.2,
  });
  assert.equal(decision.allowed, false);
  assert.ok(decision.failures.includes("critical-evidence-contradiction"));
});

test("denies completion with unreconciled external effects", () => {
  const decision = evaluateOmegaCompletion({
    criteria: [{ criterionId: "AC-1" }],
    proofs: [passingProof()],
    riskClass: "R1",
    unresolvedCriticalContradictions: 0,
    unreconciledExternalEffects: 1,
    residualUncertainty: 0.1,
    uncertaintyBudget: 0.2,
  });
  assert.equal(decision.allowed, false);
  assert.ok(decision.failures.includes("external-effects-unreconciled"));
});

test("R3 and R4 require independent validation", () => {
  assert.equal(riskRequiresIndependentValidation("R2"), false);
  assert.equal(riskRequiresIndependentValidation("R3"), true);
  assert.equal(riskRequiresIndependentValidation("R4"), true);

  const decision = evaluateOmegaCompletion({
    criteria: [{ criterionId: "AC-1" }],
    proofs: [passingProof()],
    riskClass: "R3",
    unresolvedCriticalContradictions: 0,
    unreconciledExternalEffects: 0,
    residualUncertainty: 0.1,
    uncertaintyBudget: 0.2,
  });
  assert.equal(decision.allowed, false);
  assert.ok(decision.failures.includes("criterion-missing-independent-proof:AC-1"));
});

test("allows completion from criterion definitions plus current proof evidence", () => {
  const decision = evaluateOmegaCompletion({
    criteria: [{ criterionId: "AC-1" }],
    proofs: [passingProof()],
    riskClass: "R2",
    unresolvedCriticalContradictions: 0,
    unreconciledExternalEffects: 0,
    residualUncertainty: 0.1,
    uncertaintyBudget: 0.2,
  });
  assert.deepEqual(decision, { allowed: true, failures: [] });
});

test("returns an immutable completion decision", () => {
  const decision = evaluateOmegaCompletion({
    criteria: [{ criterionId: "AC-1" }],
    proofs: [passingProof()],
    riskClass: "R0",
    unresolvedCriticalContradictions: 0,
    unreconciledExternalEffects: 0,
    residualUncertainty: 0,
    uncertaintyBudget: 0.2,
  });

  assert.equal(Object.isFrozen(decision), true);
  assert.equal(Object.isFrozen(decision.failures), true);
});

test("rejects invalid residual uncertainty", () => {
  const decision = evaluateOmegaCompletion({
    criteria: [{ criterionId: "AC-1" }],
    proofs: [passingProof()],
    riskClass: "R0",
    unresolvedCriticalContradictions: 0,
    unreconciledExternalEffects: 0,
    residualUncertainty: Number.NaN,
    uncertaintyBudget: 0.2,
  });
  assert.equal(decision.allowed, false);
  assert.ok(decision.failures.includes("invalid-residual-uncertainty"));
});
