import assert from "node:assert/strict";
import test from "node:test";

import { evaluateOmegaCompletion } from "../src/omega/policy.js";

test("R3 independent proof must support the criterion evidence", () => {
  const decision = evaluateOmegaCompletion({
    riskClass: "R3",
    unresolvedCriticalContradictions: 0,
    unresolvedActionContracts: 0,
    invalidEvidenceRefs: 0,
    residualUncertainty: 0.1,
    uncertaintyBudget: 0.2,
    criteria: [
      {
        criterionId: "AC-1",
        status: "satisfied",
        evidenceRefs: ["EV-1"],
      },
    ],
    proofs: [
      {
        criterionId: "AC-1",
        result: "pass",
        independent: false,
        evidenceRefs: ["EV-1"],
      },
      {
        criterionId: "AC-1",
        result: "pass",
        independent: true,
        evidenceRefs: ["EV-2"],
      },
    ],
  });

  assert.equal(decision.allowed, false);
  assert.ok(decision.failures.includes("criterion-missing-independent-proof:AC-1"));
});
