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
} from "../../types.js";

type Activities = typeof import("../activities/mockPassActivities.js");

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

/**
 * Runtime shape check for a signal payload that TypeScript only promises is
 * an `ApprovalResponse` at compile time. `decision` is checked for presence
 * as a string only — whether it's one of the actual `ApprovalDecision`
 * literals is validated later, where an invalid-but-well-typed value is
 * rejected with a proper terminal failure state instead of silently dropped.
 */
function isWellFormedApprovalResponse(value: unknown): value is ApprovalResponse {
  if (typeof value !== "object" || value === null) return false;
  const candidate = value as Record<string, unknown>;
  return (
    typeof candidate.approvalId === "string" &&
    typeof candidate.missionId === "string" &&
    typeof candidate.candidateSha === "string" &&
    typeof candidate.decision === "string" &&
    typeof candidate.approvalCycle === "number"
  );
}

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
  // A response is only ever applied if ALL of these hold:
  //  - approvalRequestOutstanding: a request is actually pending right now
  //    (false during BUILD/REVIEW/TEST/REWORKING — a signal that arrives
  //    before notifyBenny has even been called must not sit around and get
  //    silently consumed once a request finally opens).
  //  - approvalCycle matches: correlates the response to the request it
  //    answers (0 initial, 1 the single post-MODIFY re-request); a late
  //    response to a superseded cycle is stale.
  //  - missionId and candidateSha match: defense-in-depth payload
  //    validation. Note this is *not* what protects against merging a
  //    changed HEAD — that's the independent SHA_VERIFICATION check against
  //    a fresh `getCurrentCommitSha` read, right before MERGE (PASS-09).
  //    This check only guards against a malformed/misdirected signal
  //    payload being accepted in the first place.
  //  - approval is still undefined: the first valid response for an
  //    outstanding request is immutable. Without this, a second signal for
  //    the same cycle (e.g. a conflicting MODIFY arriving after an already
  //    -applied APPROVE, before the workflow has resumed and cleared the
  //    request) would silently overwrite Benny's actual decision.
  let approval: ApprovalResponse | undefined;
  let currentApprovalCycle = 0;
  let approvalRequestOutstanding = false;
  let outstandingApprovedSha = "";

  setHandler(bennyApprovalSignal, (response) => {
    // Temporal deserializes whatever bytes a client sent — TypeScript's
    // `ApprovalResponse` type is a compile-time-only promise, not a runtime
    // guarantee. A malformed payload (null, a string, an object missing
    // these fields) would otherwise throw inside this handler on property
    // access, failing the workflow task; since a failed workflow task
    // retries indefinitely against the same undeliverable signal, that
    // would leave the mission stuck rather than just ignoring the bad
    // signal. Validate the shape first and drop anything that doesn't
    // match, same as any other misdirected/stale signal.
    if (!isWellFormedApprovalResponse(response)) return;
    if (!approvalRequestOutstanding) return;
    if (approval !== undefined) return;
    if (response.approvalCycle !== currentApprovalCycle) return;
    if (response.missionId !== intent.id) return;
    if (response.candidateSha !== outstandingApprovedSha) return;
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
  // BuildResult.success is part of the contract but the mock activity
  // always returns true today — check it anyway. An activity that reports
  // failure must not be silently treated as a usable build; review/test
  // would otherwise run against (and merge could ship) a build the
  // activity itself says didn't succeed.
  if (!buildResult.success) {
    return terminal("FAILED", phase, reviewCycles, "BUILD", "Build activity reported failure");
  }
  completedSteps.push("BUILD");

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
    if (!buildResult.success) {
      return terminal("FAILED", phase, reviewCycles, "REWORK", "Rework activity reported failure");
    }

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
    if (!buildResult.success) {
      return terminal(
        "FAILED",
        phase,
        testCycles,
        "TEST_REPAIR",
        "Repair activity reported failure",
      );
    }

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
    // Opened *before* the AWAITING_APPROVAL status/notifyBenny below, not
    // after — a query-polling caller (see tests) can observe `status ===
    // "AWAITING_APPROVAL"` the instant it's set, and notifyBenny is a real
    // awaited Activity call that takes nonzero (and under load, sometimes
    // non-trivial) wall-clock time. Flipping this flag afterward left a
    // window where a signal sent right after the caller saw
    // AWAITING_APPROVAL would be silently dropped as "no request
    // outstanding," hanging the mission until the 72h default timeout —
    // rare when everything's fast, real under concurrent test load.
    outstandingApprovedSha = approvedSha;
    approvalRequestOutstanding = true;

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
    approvalRequestOutstanding = false;
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

    // Signal payloads are not runtime-validated by Temporal — a client can
    // send any string as `decision`. Only REJECT, MODIFY, and the literal
    // "APPROVE" are meaningful; anything else must fail closed rather than
    // silently falling through to the approval path below.
    if (firstApproval.decision !== "MODIFY" && (firstApproval.decision as string) !== "APPROVE") {
      return terminal(
        "FAILED",
        phase,
        reviewCycles,
        "BENNY_APPROVAL",
        `Invalid approval decision: ${String(firstApproval.decision)}`,
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
      approvalRequestOutstanding = false;
      // Leaving `status` at "AWAITING_APPROVAL" through the rework/retest
      // below would make it indistinguishable from "the second approval
      // request is now open" to anyone polling status alone — it never
      // actually left that value. A caller polling for AWAITING_APPROVAL
      // right after sending MODIFY could then observe this *stale* leftover
      // status, read the pre-rework SHA, and send its next signal before
      // the real second window (and its new candidateSha) exists.
      status = "RUNNING";

      phase = "REWORKING";
      buildResult = await executeRework({
        missionId: intent.id,
        stepId: "modify-rework",
        repo,
        buildResult,
        reviewResult: { changesRequired: true, feedback: modificationFeedback, severity: "MAJOR" },
      });
      if (!buildResult.success) {
        return terminal(
          "FAILED",
          phase,
          reviewCycles,
          "MODIFY_REWORK",
          "Rework activity reported failure",
        );
      }
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

      outstandingApprovedSha = approvedSha;
      approvalRequestOutstanding = true;

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
      approvalRequestOutstanding = false;
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

      // Same runtime-validation gap as the first response: only the literal
      // "APPROVE" may proceed past this point.
      if ((secondApproval.decision as string) !== "APPROVE") {
        return terminal(
          "FAILED",
          phase,
          reviewCycles,
          "BENNY_APPROVAL_MODIFY",
          `Invalid approval decision: ${String(secondApproval.decision)}`,
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
