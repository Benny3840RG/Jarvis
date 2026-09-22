import assert from "node:assert/strict";
import { describe, it } from "node:test";

import type { BuildResult } from "../../src/preview/temporalPass/types.js";
import {
  executeReview,
  runTests,
} from "../../src/preview/temporalPass/temporal/activities/mockPassActivities.js";

// A retry of an Activity is, from Temporal's point of view, the exact same
// logical operation running again — the first attempt's completion was lost
// (never durably recorded) before Temporal could observe it, so it schedules
// another attempt with the identical input. executeReview/runTests must
// therefore be pure functions of their input (specifically the workflow's
// durable per-cycle `stepId`, e.g. "review" / "review-1" / "review-2"), not
// of any process-local mutable state. A prior implementation kept an
// in-memory `Map<missionId, count>` that advanced on every *call*, so a lost-
// completion retry of the very first review attempt silently became "the
// second call" and could flip `changesRequired` from true to false — required
// rework would then be skipped even though it was never actually approved.
const buildResult: BuildResult = { commitSha: "build-sha", success: true };

describe("PASS review/test decisions are attempt-stable across Activity retries", () => {
  it("executeReview returns the same decision when the same stepId is retried", async () => {
    const missionId = `retry-stable-review-${Date.now()}`;
    const scenario = { reviewChangesForCycles: 1 };

    const firstAttempt = await executeReview({
      missionId,
      stepId: "review",
      buildResult,
      scenario,
    });
    assert.equal(firstAttempt.changesRequired, true);

    // Simulates Temporal retrying the same logical Activity invocation (same
    // stepId) after the first attempt's completion was lost.
    const retryOfFirstAttempt = await executeReview({
      missionId,
      stepId: "review",
      buildResult,
      scenario,
    });
    assert.deepEqual(
      retryOfFirstAttempt,
      firstAttempt,
      "a retried review Activity must return the same decision as the attempt whose completion was lost",
    );

    const secondCycle = await executeReview({
      missionId,
      stepId: "review-1",
      buildResult,
      scenario,
    });
    assert.equal(secondCycle.changesRequired, false);

    const retryOfSecondCycle = await executeReview({
      missionId,
      stepId: "review-1",
      buildResult,
      scenario,
    });
    assert.deepEqual(retryOfSecondCycle, secondCycle);
  });

  it("runTests returns the same decision when the same stepId is retried", async () => {
    const missionId = `retry-stable-test-${Date.now()}`;
    const scenario = { testFailuresForCycles: 1 };

    const firstAttempt = await runTests({ missionId, stepId: "test", buildResult, scenario });
    assert.equal(firstAttempt.passed, false);

    const retryOfFirstAttempt = await runTests({
      missionId,
      stepId: "test",
      buildResult,
      scenario,
    });
    assert.deepEqual(
      retryOfFirstAttempt,
      firstAttempt,
      "a retried test Activity must return the same decision as the attempt whose completion was lost",
    );

    const secondCycle = await runTests({ missionId, stepId: "test-1", buildResult, scenario });
    assert.equal(secondCycle.passed, true);

    const retryOfSecondCycle = await runTests({
      missionId,
      stepId: "test-1",
      buildResult,
      scenario,
    });
    assert.deepEqual(retryOfSecondCycle, secondCycle);
  });

  it("recognizes the post-modify one-off stepIds used by the Benny MODIFY rework path", async () => {
    const reviewDecision = await executeReview({
      missionId: "post-modify-review",
      stepId: "post-modify-review",
      buildResult,
      scenario: {},
    });
    assert.equal(reviewDecision.changesRequired, false);

    const testDecision = await runTests({
      missionId: "post-modify-test",
      stepId: "post-modify-test",
      buildResult,
      scenario: {},
    });
    assert.equal(testDecision.passed, true);
  });

  it("rejects a malformed stepId instead of silently mis-deriving the cycle", async () => {
    await assert.rejects(
      () =>
        executeReview({
          missionId: "malformed-stepid",
          stepId: "review-abc",
          buildResult,
          scenario: { reviewChangesForCycles: 1 },
        }),
      /Invalid review step id/,
    );
  });
});
