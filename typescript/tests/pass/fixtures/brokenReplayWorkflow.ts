/**
 * TEST FIXTURE ONLY — used exclusively by replay-upgrade.test.ts (PASS-14)
 * to prove that Temporal's replay determinism check actually catches a
 * broken workflow-code upgrade, rather than silently corrupting a mission
 * parked mid-flight. This is a copy of the real
 * `src/preview/temporalPass/temporal/workflows/passWorkflow.ts` with ONE
 * deliberate, marked change that makes it incompatible with histories
 * produced by the real file. Never import this outside that test.
 */
import {
  condition,
  defineQuery,
  defineSignal,
  proxyActivities,
  setHandler,
} from "@temporalio/workflow";

import type {
  ApprovalResponse,
  BuildResult,
  MissionIntent,
  MissionPhase,
  MissionState,
  MissionStatus,
  ReviewResult,
  TestResult,
} from "../../../src/preview/temporalPass/types.js";

type Activities =
  typeof import("../../../src/preview/temporalPass/temporal/activities/mockPassActivities.js");

// executeBuild and mergePR can be held open (heartbeating) by test-only
// scenario knobs (buildDelayMs/mergeDelayMs — see PASS-01/PASS-13), so both
// need a heartbeatTimeout for Temporal to notice a dead worker promptly
// instead of waiting out the full startToCloseTimeout.
const { executeBuild, mergePR } = proxyActivities<Pick<Activities, "executeBuild" | "mergePR">>({
  startToCloseTimeout: "30 seconds",
  heartbeatTimeout: "2 seconds",
});

const {
  executeReview,
  executeRework,
  runTests,
  repairTests,
  getCurrentCommitSha,
  notifyBenny,
  checkBranchProtection,
} = proxyActivities<Omit<Activities, "executeBuild" | "mergePR">>({
  startToCloseTimeout: "30 seconds",
});

export const bennyApprovalSignal = defineSignal<[ApprovalResponse]>("bennyApproval");
export const getMissionStateQuery = defineQuery<MissionState, []>("getMissionState");

const DEFAULT_APPROVAL_TIMEOUT_MS = 72 * 60 * 60 * 1000;
const MAX_REVIEW_CYCLES = 3;
const MAX_TEST_CYCLES = 2;

export async function passWorkflow(intent: MissionIntent): Promise<MissionState> {
  const repo = intent.context?.repo ?? "mock-repo";
  const completedSteps: string[] = [];
  let status: MissionStatus = "PENDING";
  let phase: MissionPhase = "PLANNING";
  let reviewCycles = 0;
  let testCycles = 0;
  let failedStep: string | undefined;
  let failureReason: string | undefined;

  function terminal(
    nextStatus: MissionStatus,
    nextPhase: MissionPhase,
    iteration: number,
    nextFailedStep?: string,
    nextFailureReason?: string,
  ): MissionState {
    status = nextStatus;
    phase = nextPhase;
    failedStep = nextFailedStep;
    failureReason = nextFailureReason;
    return { status, phase, iteration, completedSteps, failedStep, failureReason };
  }

  // --- Approval signal handling -----------------------------------------
  // approvalCycle correlates a response to the request it answers: 0 for
  // the initial request, 1 for the single post-MODIFY re-request. A signal
  // whose cycle doesn't match what's currently outstanding is stale (e.g.
  // a late response to cycle 0 arriving after MODIFY already advanced the
  // mission to cycle 1) and must never be silently applied.
  let approval: ApprovalResponse | undefined;
  let currentApprovalCycle = 0;

  setHandler(bennyApprovalSignal, (response) => {
    if (response.approvalCycle !== currentApprovalCycle) return;
    approval = response;
  });

  // Reading `approval` through a function call (rather than referencing the
  // captured `let` directly) is deliberate: TypeScript's control-flow
  // narrowing treats the explicit `approval = undefined;` reset below as
  // sticky across the subsequent `await condition(...)` calls, even though
  // the signal handler closure can reassign it in between. Routing every
  // read through this indirection gives each call site the honest
  // `ApprovalResponse | undefined` type instead of a stale `never`.
  function readApproval(): ApprovalResponse | undefined {
    return approval;
  }

  setHandler(getMissionStateQuery, () => ({
    status,
    phase,
    iteration: reviewCycles,
    completedSteps,
    failedStep,
    failureReason,
  }));

  status = "RUNNING";
  phase = "PLANNING";
  completedSteps.push("PLAN");

  // --- BUILD ---------------------------------------------------------------
  phase = "BUILDING";
  let buildResult: BuildResult = await executeBuild({
    missionId: intent.id,
    stepId: "build",
    intent,
  });
  completedSteps.push("BUILD");

  // DELIBERATE BREAK (PASS-14 fixture only): a real history captured from
  // the unmodified workflow has ActivityTaskScheduled(executeReview) as its
  // second scheduled Activity. This extra call makes it
  // ActivityTaskScheduled(notifyBenny) instead — a command-sequence mismatch
  // that Temporal's replayer must reject when replaying that history
  // against this file.
  await notifyBenny({
    missionId: intent.id,
    stepId: "unexpected-extra-notify",
    type: "BENNY_REQUEST",
    recipient: "benny",
    content: { summary: "this call should never have existed" },
  });

  // --- REVIEW / REWORK (bounded) --------------------------------------------
  phase = "REVIEWING";
  let reviewResult: ReviewResult = await executeReview({
    missionId: intent.id,
    stepId: "review",
    buildResult,
    scenario: intent.scenario,
  });

  while (reviewResult.changesRequired && reviewCycles < MAX_REVIEW_CYCLES) {
    reviewCycles++;
    phase = "REWORKING";
    buildResult = await executeRework({
      missionId: intent.id,
      stepId: `rework-${reviewCycles}`,
      repo,
      buildResult,
      reviewResult,
    });

    phase = "REVIEWING";
    reviewResult = await executeReview({
      missionId: intent.id,
      stepId: `review-${reviewCycles}`,
      buildResult,
      scenario: intent.scenario,
    });
  }

  if (reviewResult.changesRequired) {
    return terminal(
      "FAILED",
      phase,
      reviewCycles,
      "REVIEW",
      `Exceeded max review cycles (${MAX_REVIEW_CYCLES})`,
    );
  }
  completedSteps.push("REVIEW");

  // --- TEST / REPAIR (bounded) ----------------------------------------------
  phase = "TESTING";
  let testResult: TestResult = await runTests({
    missionId: intent.id,
    stepId: "test",
    buildResult,
    scenario: intent.scenario,
  });

  while (!testResult.passed && testCycles < MAX_TEST_CYCLES) {
    if (!testResult.isRepairable) {
      return terminal("FAILED", phase, testCycles, "TEST", testResult.failureReason);
    }

    testCycles++;
    phase = "TEST_REPAIRING";
    buildResult = await repairTests({
      missionId: intent.id,
      stepId: `repair-${testCycles}`,
      repo,
      buildResult,
      testResult,
    });

    phase = "TESTING";
    testResult = await runTests({
      missionId: intent.id,
      stepId: `test-${testCycles}`,
      buildResult,
      scenario: intent.scenario,
    });
  }

  if (!testResult.passed) {
    return terminal(
      "FAILED",
      phase,
      testCycles,
      "TEST",
      testResult.isRepairable
        ? `Exceeded max test repair cycles (${MAX_TEST_CYCLES}): ${testResult.failureReason}`
        : testResult.failureReason,
    );
  }
  completedSteps.push("TEST");

  let approvedSha = buildResult.commitSha;

  // --- BENNY APPROVAL --------------------------------------------------------
  if (intent.constraints?.requireApproval) {
    phase = "AWAITING_APPROVAL";
    status = "AWAITING_APPROVAL";

    await notifyBenny({
      missionId: intent.id,
      stepId: `approval-request-${currentApprovalCycle}`,
      type: "BENNY_REQUEST",
      recipient: "benny",
      content: {
        summary: "Mission ready for approval",
        approvedSha,
        approvalCycle: currentApprovalCycle,
      },
    });

    const timeoutMs = intent.constraints.approvalTimeoutMs ?? DEFAULT_APPROVAL_TIMEOUT_MS;
    const received = await condition(() => readApproval() !== undefined, timeoutMs);
    if (!received) {
      return terminal("CANCELLED", phase, reviewCycles, "BENNY_APPROVAL", "Benny approval timeout");
    }
    const firstApproval = readApproval();
    if (!firstApproval) {
      throw new Error("Unreachable: approval missing after condition resolved");
    }

    if (firstApproval.decision === "REJECT") {
      return terminal(
        "REJECTED",
        phase,
        reviewCycles,
        "BENNY_APPROVAL",
        firstApproval.reasoning ?? "Benny rejected",
      );
    }

    if (firstApproval.decision === "MODIFY") {
      // Capture everything needed from `firstApproval` before resetting
      // `approval` — reading a *stale local* is fine, but reading
      // `approval` itself after `approval = undefined` is exactly the bug
      // the original handover called out (and a later "ready" draft
      // reintroduced): the reset really does make it undefined at runtime.
      const modificationFeedback =
        firstApproval.modifications?.feedback ?? "Benny requested modifications";
      approval = undefined;
      currentApprovalCycle = 1;

      phase = "REWORKING";
      buildResult = await executeRework({
        missionId: intent.id,
        stepId: "modify-rework",
        repo,
        buildResult,
        reviewResult: { changesRequired: true, feedback: modificationFeedback, severity: "MAJOR" },
      });
      approvedSha = buildResult.commitSha;

      phase = "REVIEWING";
      const postModifyReview = await executeReview({
        missionId: intent.id,
        stepId: "post-modify-review",
        buildResult,
        scenario: intent.scenario,
      });
      if (postModifyReview.changesRequired) {
        return terminal(
          "FAILED",
          phase,
          reviewCycles,
          "POST_MODIFY_REVIEW",
          postModifyReview.feedback,
        );
      }

      phase = "TESTING";
      const postModifyTest = await runTests({
        missionId: intent.id,
        stepId: "post-modify-test",
        buildResult,
        scenario: intent.scenario,
      });
      if (!postModifyTest.passed) {
        return terminal(
          "FAILED",
          phase,
          testCycles,
          "POST_MODIFY_TEST",
          postModifyTest.failureReason,
        );
      }

      phase = "AWAITING_APPROVAL";
      status = "AWAITING_APPROVAL";
      await notifyBenny({
        missionId: intent.id,
        stepId: "approval-request-1",
        type: "BENNY_REQUEST",
        recipient: "benny",
        content: {
          summary: "Mission modified, re-requesting approval",
          approvedSha,
          approvalCycle: 1,
        },
      });

      const secondReceived = await condition(() => readApproval() !== undefined, timeoutMs);
      if (!secondReceived) {
        return terminal(
          "CANCELLED",
          phase,
          reviewCycles,
          "BENNY_APPROVAL_MODIFY",
          "Benny approval timeout after modification",
        );
      }
      const secondApproval = readApproval();
      if (!secondApproval) {
        throw new Error("Unreachable: approval missing after condition resolved");
      }

      // A response to the post-MODIFY request can only be APPROVE or
      // REJECT — the signal handler already refuses to apply a
      // mismatched-cycle response, but a same-cycle MODIFY must also be
      // rejected here since a mission may only be modified once.
      if (secondApproval.decision === "MODIFY") {
        return terminal(
          "FAILED",
          phase,
          reviewCycles,
          "BENNY_APPROVAL_MODIFY",
          "Cannot MODIFY a modification — must APPROVE or REJECT",
        );
      }
      if (secondApproval.decision === "REJECT") {
        return terminal(
          "REJECTED",
          phase,
          reviewCycles,
          "BENNY_APPROVAL_MODIFY",
          secondApproval.reasoning ?? "Benny rejected modification",
        );
      }
    }

    completedSteps.push("BENNY_APPROVAL");
  }

  // --- SHA verification + branch protection + MERGE ---------------------------
  phase = "MERGING";
  status = "RUNNING";

  const currentSha = await getCurrentCommitSha({
    missionId: intent.id,
    stepId: "pre-merge-sha-check",
    repo,
    branch: intent.context?.branch ?? "main",
  });
  if (currentSha.sha !== approvedSha) {
    return terminal(
      "FAILED",
      phase,
      reviewCycles,
      "SHA_VERIFICATION",
      `HEAD SHA changed after approval: ${approvedSha} -> ${currentSha.sha}`,
    );
  }

  const branchProtection = await checkBranchProtection({
    missionId: intent.id,
    stepId: "branch-protection-check",
    repo,
    branch: intent.context?.branch ?? "main",
  });
  if (!branchProtection.satisfied) {
    return terminal("FAILED", phase, reviewCycles, "BRANCH_PROTECTION", branchProtection.reason);
  }

  await mergePR({
    missionId: intent.id,
    stepId: "merge",
    repo,
    prNumber: intent.context?.prNumber ?? 1,
    expectedSha: approvedSha,
    scenario: intent.scenario,
  });
  completedSteps.push("MERGE");

  // --- VERIFY -----------------------------------------------------------------
  phase = "VERIFYING";
  completedSteps.push("VERIFY");
  status = "COMPLETED";

  return terminal("COMPLETED", phase, reviewCycles);
}
