import assert from "node:assert/strict";
import test from "node:test";

import {
  canTransitionOmegaMission,
  evaluateOmegaCompletion,
  riskRequiresIndependentValidation,
} from "../src/omega/policy.js";

test("forbids blocked -> complete shortcut", () => {
  assert.equal(canTransitionOmegaMission("blocked", "complete"), false);
});

test("requires evidence for satisfied criteria", () => {
  const decision = evaluateOmegaCompletion({
    criteria: [{ criterionId: "AC-1", status: "satisfied", evidenceRefs: [] }],
    proofs: [],
    riskClass: "R1",
    unresolvedCriticalContradictions: 0,
    unreconciledExternalEffects: 0,
    residualUncertainty: 0,
    uncertaintyBudget: 0.2,
  });
  assert.equal(decision.allowed, false);
  assert.ok(decision.failures.includes("satisfied-criterion-missing-evidence"));
});

test("requires a passing proof for every satisfied criterion", () => {
  const decision = evaluateOmegaCompletion({
    criteria: [{ criterionId: "AC-1", status: "satisfied", evidenceRefs: ["EV-1"] }],
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
    criteria: [{ criterionId: "AC-1", status: "waived", evidenceRefs: [] }],
    proofs: [
      {
        criterionId: "AC-404",
        result: "pass",
        independent: true,
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
  assert.ok(decision.failures.includes("validation-proof-unknown-criterion"));
});

test("requires proof evidence to overlap criterion evidence", () => {
  const decision = evaluateOmegaCompletion({
    criteria: [{ criterionId: "AC-1", status: "satisfied", evidenceRefs: ["EV-1"] }],
    proofs: [
      {
        criterionId: "AC-1",
        result: "pass",
        independent: false,
        evidenceRefs: ["EV-2"],
      },
    ],
    riskClass: "R1",
    unresolvedCriticalContradictions: 0,
    unreconciledExternalEffects: 0,
    residualUncertainty: 0.1,
    uncertaintyBudget: 0.2,
  });
  assert.equal(decision.allowed, false);
  assert.ok(decision.failures.includes("criterion-proof-evidence-mismatch:AC-1"));
});

test("denies completion with unreconciled external effects", () => {
  const decision = evaluateOmegaCompletion({
    criteria: [{ criterionId: "AC-1", status: "satisfied", evidenceRefs: ["EV-1"] }],
    proofs: [
      {
        criterionId: "AC-1",
        result: "pass",
        independent: false,
        evidenceRefs: ["EV-1"],
      },
    ],
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
    criteria: [{ criterionId: "AC-1", status: "satisfied", evidenceRefs: ["EV-1"] }],
    proofs: [
      {
        criterionId: "AC-1",
        result: "pass",
        independent: false,
        evidenceRefs: ["EV-1"],
      },
    ],
    riskClass: "R3",
    unresolvedCriticalContradictions: 0,
    unreconciledExternalEffects: 0,
    residualUncertainty: 0.1,
    uncertaintyBudget: 0.2,
  });
  assert.equal(decision.allowed, false);
  assert.ok(decision.failures.includes("criterion-missing-independent-proof:AC-1"));
});

test("allows a fully evidenced low-risk completion", () => {
  const decision = evaluateOmegaCompletion({
    criteria: [{ criterionId: "AC-1", status: "satisfied", evidenceRefs: ["EV-1"] }],
    proofs: [
      {
        criterionId: "AC-1",
        result: "pass",
        independent: false,
        evidenceRefs: ["EV-1"],
      },
    ],
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
    criteria: [{ criterionId: "AC-1", status: "waived", evidenceRefs: [] }],
    proofs: [],
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
    criteria: [{ criterionId: "AC-1", status: "waived", evidenceRefs: [] }],
    proofs: [],
    riskClass: "R0",
    unresolvedCriticalContradictions: 0,
    unreconciledExternalEffects: 0,
    residualUncertainty: Number.NaN,
    uncertaintyBudget: 0.2,
  });
  assert.equal(decision.allowed, false);
  assert.ok(decision.failures.includes("invalid-residual-uncertainty"));
});
