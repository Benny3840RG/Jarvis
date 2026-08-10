import assert from "node:assert/strict";
import test from "node:test";

import {
  canTransitionOmegaMission,
  evaluateOmegaCompletion,
  riskRequiresIndependentValidation,
} from "../src/omega/policy.js";

const base = {
  riskClass: "R1" as const,
  unresolvedCriticalContradictions: 0,
  unresolvedActionContracts: 0,
  invalidEvidenceRefs: 0,
  residualUncertainty: 0.1,
  uncertaintyBudget: 0.2,
};

test("forbids blocked -> complete shortcut", () => {
  assert.equal(canTransitionOmegaMission("blocked", "complete"), false);
});

test("requires evidence for satisfied criteria", () => {
  const decision = evaluateOmegaCompletion({
    ...base,
    criteria: [{ criterionId: "AC-1", status: "satisfied", evidenceRefs: [] }],
    proofs: [],
  });
  assert.equal(decision.allowed, false);
  assert.ok(decision.failures.includes("completed-criterion-missing-evidence"));
});

test("requires a passing proof for every satisfied criterion", () => {
  const decision = evaluateOmegaCompletion({
    ...base,
    criteria: [{ criterionId: "AC-1", status: "satisfied", evidenceRefs: ["EV-1"] }],
    proofs: [],
  });
  assert.equal(decision.allowed, false);
  assert.ok(decision.failures.includes("criterion-missing-passing-proof:AC-1"));
});

test("rejects proofs for unknown criteria", () => {
  const decision = evaluateOmegaCompletion({
    ...base,
    criteria: [{ criterionId: "AC-1", status: "waived", evidenceRefs: ["EV-1"] }],
    proofs: [
      {
        criterionId: "AC-404",
        result: "pass",
        independent: true,
        evidenceRefs: ["EV-1"],
      },
    ],
  });
  assert.equal(decision.allowed, false);
  assert.ok(decision.failures.includes("validation-proof-unknown-criterion"));
});

test("requires proof evidence to overlap criterion evidence", () => {
  const decision = evaluateOmegaCompletion({
    ...base,
    criteria: [{ criterionId: "AC-1", status: "satisfied", evidenceRefs: ["EV-1"] }],
    proofs: [
      {
        criterionId: "AC-1",
        result: "pass",
        independent: false,
        evidenceRefs: ["EV-2"],
      },
    ],
  });
  assert.equal(decision.allowed, false);
  assert.ok(decision.failures.includes("criterion-proof-evidence-mismatch:AC-1"));
});

test("denies completion with unresolved action contracts", () => {
  const decision = evaluateOmegaCompletion({
    ...base,
    criteria: [{ criterionId: "AC-1", status: "satisfied", evidenceRefs: ["EV-1"] }],
    proofs: [
      {
        criterionId: "AC-1",
        result: "pass",
        independent: false,
        evidenceRefs: ["EV-1"],
      },
    ],
    unresolvedActionContracts: 1,
  });
  assert.equal(decision.allowed, false);
  assert.ok(decision.failures.includes("action-contracts-unresolved"));
});

test("R3 and R4 require independent validation", () => {
  assert.equal(riskRequiresIndependentValidation("R2"), false);
  assert.equal(riskRequiresIndependentValidation("R3"), true);
  assert.equal(riskRequiresIndependentValidation("R4"), true);

  const decision = evaluateOmegaCompletion({
    ...base,
    riskClass: "R3",
    criteria: [{ criterionId: "AC-1", status: "satisfied", evidenceRefs: ["EV-1"] }],
    proofs: [
      {
        criterionId: "AC-1",
        result: "pass",
        independent: false,
        evidenceRefs: ["EV-1"],
      },
    ],
  });
  assert.equal(decision.allowed, false);
  assert.ok(decision.failures.includes("criterion-missing-independent-proof:AC-1"));
});

test("high-risk criteria cannot be waived", () => {
  const decision = evaluateOmegaCompletion({
    ...base,
    riskClass: "R4",
    criteria: [{ criterionId: "AC-1", status: "waived", evidenceRefs: ["EV-1"] }],
    proofs: [
      {
        criterionId: "AC-1",
        result: "waived",
        independent: true,
        evidenceRefs: ["EV-1"],
      },
    ],
  });
  assert.equal(decision.allowed, false);
  assert.ok(decision.failures.includes("high-risk-criterion-waiver-forbidden:AC-1"));
});

test("low-risk waiver requires an evidenced waiver proof", () => {
  const decision = evaluateOmegaCompletion({
    ...base,
    criteria: [{ criterionId: "AC-1", status: "waived", evidenceRefs: ["EV-1"] }],
    proofs: [],
  });
  assert.equal(decision.allowed, false);
  assert.ok(decision.failures.includes("criterion-missing-waiver-proof:AC-1"));
});

test("expired or missing referenced evidence blocks completion", () => {
  const decision = evaluateOmegaCompletion({
    ...base,
    criteria: [{ criterionId: "AC-1", status: "satisfied", evidenceRefs: ["EV-1"] }],
    proofs: [
      {
        criterionId: "AC-1",
        result: "pass",
        independent: false,
        evidenceRefs: ["EV-1"],
      },
    ],
    invalidEvidenceRefs: 1,
  });
  assert.equal(decision.allowed, false);
  assert.ok(decision.failures.includes("evidence-invalid-or-expired"));
});

test("allows a fully evidenced low-risk completion", () => {
  const decision = evaluateOmegaCompletion({
    ...base,
    riskClass: "R2",
    criteria: [{ criterionId: "AC-1", status: "satisfied", evidenceRefs: ["EV-1"] }],
    proofs: [
      {
        criterionId: "AC-1",
        result: "pass",
        independent: false,
        evidenceRefs: ["EV-1"],
      },
    ],
  });
  assert.deepEqual(decision, { allowed: true, failures: [] });
});

test("rejects invalid residual uncertainty", () => {
  const decision = evaluateOmegaCompletion({
    ...base,
    criteria: [{ criterionId: "AC-1", status: "waived", evidenceRefs: ["EV-1"] }],
    proofs: [
      {
        criterionId: "AC-1",
        result: "waived",
        independent: false,
        evidenceRefs: ["EV-1"],
      },
    ],
    residualUncertainty: Number.NaN,
  });
  assert.equal(decision.allowed, false);
  assert.ok(decision.failures.includes("invalid-residual-uncertainty"));
});
