import assert from "node:assert/strict";
import test from "node:test";

import {
  evaluateDevelopmentTransition,
  type ReviewEvidence,
  type VerificationEvidence,
} from "../src/development/stateMachine.js";

const baseRequestFields = {
  now: "2026-09-01T00:00:00.000Z",
  requestedBy: { actorType: "worker" as const, actorId: "worker-1" },
  committedBy: { actorType: "controller" as const, actorId: "development-controller" },
};

const passedVerification: VerificationEvidence = {
  checksPassed: true,
  hasBlockingFindings: false,
  receiptId: "verification-receipt-1",
};

const completedCleanReview: ReviewEvidence = {
  reviewComplete: true,
  hasBlockingFindings: false,
  receiptId: "review-receipt-1",
};

test("VERIFYING -> REVIEW is rejected outright when no verification evidence is supplied", () => {
  // This is the gap the registry's own gates/evidenceRequired declare
  // ("required_verification_checks_passed", "verification_receipts") but
  // that nothing previously enforced -- a caller could reach REVIEW with
  // literally no proof any check ran.
  const result = evaluateDevelopmentTransition({
    ...baseRequestFields,
    transitionId: "DEV_TRANSITION_VERIFYING_TO_REVIEW",
    from: "VERIFYING",
    to: "REVIEW",
  });

  assert.equal(result.allowed, false);
  assert.ok(result.reasons.includes("VERIFICATION_EVIDENCE_REQUIRED"));
});

test("VERIFYING -> REVIEW is rejected when verification checks did not pass", () => {
  const result = evaluateDevelopmentTransition({
    ...baseRequestFields,
    transitionId: "DEV_TRANSITION_VERIFYING_TO_REVIEW",
    from: "VERIFYING",
    to: "REVIEW",
    verificationEvidence: { ...passedVerification, checksPassed: false },
  });

  assert.equal(result.allowed, false);
  assert.ok(result.reasons.includes("VERIFICATION_CHECKS_NOT_PASSED"));
});

test("VERIFYING -> REVIEW is rejected when verification has blocking findings", () => {
  const result = evaluateDevelopmentTransition({
    ...baseRequestFields,
    transitionId: "DEV_TRANSITION_VERIFYING_TO_REVIEW",
    from: "VERIFYING",
    to: "REVIEW",
    verificationEvidence: { ...passedVerification, hasBlockingFindings: true },
  });

  assert.equal(result.allowed, false);
  assert.ok(result.reasons.includes("BLOCKING_VERIFICATION_FINDINGS_PRESENT"));
});

test("VERIFYING -> REVIEW is admitted once verification evidence proves checks passed cleanly", () => {
  const result = evaluateDevelopmentTransition({
    ...baseRequestFields,
    transitionId: "DEV_TRANSITION_VERIFYING_TO_REVIEW",
    from: "VERIFYING",
    to: "REVIEW",
    verificationEvidence: passedVerification,
  });

  assert.equal(result.allowed, true);
});

test("REVIEW -> READY_TO_MERGE is rejected outright when no review evidence is supplied", () => {
  const result = evaluateDevelopmentTransition({
    ...baseRequestFields,
    transitionId: "DEV_TRANSITION_REVIEW_TO_READY_TO_MERGE",
    from: "REVIEW",
    to: "READY_TO_MERGE",
  });

  assert.equal(result.allowed, false);
  assert.ok(result.reasons.includes("REVIEW_EVIDENCE_REQUIRED"));
});

test("REVIEW -> READY_TO_MERGE is rejected when review is not complete", () => {
  const result = evaluateDevelopmentTransition({
    ...baseRequestFields,
    transitionId: "DEV_TRANSITION_REVIEW_TO_READY_TO_MERGE",
    from: "REVIEW",
    to: "READY_TO_MERGE",
    reviewEvidence: { ...completedCleanReview, reviewComplete: false },
  });

  assert.equal(result.allowed, false);
  assert.ok(result.reasons.includes("INDEPENDENT_REVIEW_NOT_COMPLETE"));
});

test("REVIEW -> READY_TO_MERGE is rejected when the review has blocking findings", () => {
  const result = evaluateDevelopmentTransition({
    ...baseRequestFields,
    transitionId: "DEV_TRANSITION_REVIEW_TO_READY_TO_MERGE",
    from: "REVIEW",
    to: "READY_TO_MERGE",
    reviewEvidence: { ...completedCleanReview, hasBlockingFindings: true },
  });

  assert.equal(result.allowed, false);
  assert.ok(result.reasons.includes("BLOCKING_REVIEW_FINDINGS_PRESENT"));
});

test("REVIEW -> READY_TO_MERGE is admitted once review evidence proves a clean completed review", () => {
  const result = evaluateDevelopmentTransition({
    ...baseRequestFields,
    transitionId: "DEV_TRANSITION_REVIEW_TO_READY_TO_MERGE",
    from: "REVIEW",
    to: "READY_TO_MERGE",
    reviewEvidence: completedCleanReview,
  });

  assert.equal(result.allowed, true);
});

test("REVIEW -> REPAIR_REQUIRED is rejected when review evidence shows no blocking findings", () => {
  // The inverse polarity of the readiness gate: this transition exists
  // specifically to record that review *found* blocking issues, so it must
  // not be reachable without evidence proving that.
  const result = evaluateDevelopmentTransition({
    ...baseRequestFields,
    transitionId: "DEV_TRANSITION_REVIEW_TO_REPAIR_REQUIRED",
    from: "REVIEW",
    to: "REPAIR_REQUIRED",
    reviewEvidence: completedCleanReview,
  });

  assert.equal(result.allowed, false);
  assert.ok(result.reasons.includes("NO_BLOCKING_REVIEW_FINDINGS"));
});

test("REVIEW -> REPAIR_REQUIRED is admitted when a completed review found blocking findings", () => {
  const result = evaluateDevelopmentTransition({
    ...baseRequestFields,
    transitionId: "DEV_TRANSITION_REVIEW_TO_REPAIR_REQUIRED",
    from: "REVIEW",
    to: "REPAIR_REQUIRED",
    reviewEvidence: { ...completedCleanReview, hasBlockingFindings: true },
  });

  assert.equal(result.allowed, true);
});
