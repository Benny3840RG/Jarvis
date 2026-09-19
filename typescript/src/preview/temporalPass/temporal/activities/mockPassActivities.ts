import { Context } from "@temporalio/activity";
import { randomUUID } from "node:crypto";
import { setTimeout as sleep } from "node:timers/promises";

import { IdempotencyStore } from "../../idempotency/idempotencyStore.js";
import type {
  BranchProtectionInput,
  BranchProtectionResult,
  BuildInput,
  BuildResult,
  MergeInput,
  NotifyInput,
  RepairInput,
  ReviewInput,
  ReviewResult,
  ReworkInput,
  ShaCheckInput,
  ShaCheckResult,
  TestInput,
  TestResult,
} from "../../types.js";
import { MockRepoStateStore } from "./mockRepoState.js";

const idempotencyPath = process.env.TEMPORAL_PASS_IDEMPOTENCY_PATH;
const mockRepoPath = process.env.TEMPORAL_PASS_MOCK_REPO_PATH;

const idempotencyStore = idempotencyPath
  ? new IdempotencyStore(idempotencyPath)
  : new IdempotencyStore();
const mockRepoStateStore = mockRepoPath
  ? new MockRepoStateStore(mockRepoPath)
  : new MockRepoStateStore();

// Read-only mock decisions don't need idempotency-store durability, but they
// do need per-mission call counters to drive the bounded-loop test scenarios
// (PASS-06/07/08). An in-memory Map is fine here: these activities have no
// external side effects to duplicate, so losing the counter on a worker
// restart just means "review/tests pass a little sooner than the scenario
// asked for," never a correctness violation.
const reviewCallCounts = new Map<string, number>();
const testCallCounts = new Map<string, number>();

function repoOf(context: { repo?: string } | undefined): string {
  return context?.repo ?? "mock-repo";
}

/** Test-only hook: holds an Activity open, heartbeating, so a test can reliably SIGKILL the worker mid-flight. */
async function heartbeatingDelay(delayMs: number): Promise<void> {
  if (delayMs <= 0) return;
  const heartbeatStepMs = 250;
  const ctx = Context.current();
  for (let elapsed = 0; elapsed < delayMs; elapsed += heartbeatStepMs) {
    await sleep(Math.min(heartbeatStepMs, delayMs - elapsed));
    ctx.heartbeat();
  }
}

export async function executeBuild(input: BuildInput): Promise<BuildResult> {
  const key = `${input.missionId}:${input.stepId}:executeBuild:v1`;
  return idempotencyStore.runIdempotent(key, "executeBuild", async () => {
    // PASS-01: held open *before* the mock mutation, so a kill here means
    // the mutation never happened and the retry starts clean.
    await heartbeatingDelay(input.intent.scenario?.buildDelayMs ?? 0);

    const repo = repoOf(input.intent.context);
    const commitSha = `build-${input.missionId}-${randomUUID().slice(0, 8)}`;
    await mockRepoStateStore.update(repo, (state) => ({ ...state, currentSha: commitSha }));
    return { commitSha, success: true };
  });
}

export async function executeReview(input: ReviewInput): Promise<ReviewResult> {
  const requiredCycles = input.scenario?.reviewChangesForCycles ?? 0;
  const count = (reviewCallCounts.get(input.missionId) ?? 0) + 1;
  reviewCallCounts.set(input.missionId, count);

  if (count <= requiredCycles) {
    return {
      changesRequired: true,
      feedback: `Mock review requesting changes (cycle ${count} of ${requiredCycles})`,
      severity: "MAJOR",
    };
  }
  return { changesRequired: false, feedback: "Looks good", severity: "MINOR" };
}

export async function executeRework(input: ReworkInput): Promise<BuildResult> {
  const key = `${input.missionId}:${input.stepId}:executeRework:v1`;
  return idempotencyStore.runIdempotent(key, "executeRework", async () => {
    const commitSha = `rework-${input.missionId}-${randomUUID().slice(0, 8)}`;
    await mockRepoStateStore.update(input.repo, (state) => ({ ...state, currentSha: commitSha }));
    return { commitSha, success: true };
  });
}

export async function runTests(input: TestInput): Promise<TestResult> {
  const requiredFailures = input.scenario?.testFailuresForCycles ?? 0;
  const count = (testCallCounts.get(input.missionId) ?? 0) + 1;
  testCallCounts.set(input.missionId, count);

  if (count <= requiredFailures) {
    return {
      passed: false,
      isRepairable: !input.scenario?.testUnrepairable,
      failureReason: `Mock test failure (cycle ${count} of ${requiredFailures})`,
    };
  }
  return { passed: true };
}

export async function repairTests(input: RepairInput): Promise<BuildResult> {
  const key = `${input.missionId}:${input.stepId}:repairTests:v1`;
  return idempotencyStore.runIdempotent(key, "repairTests", async () => {
    const commitSha = `repair-${input.missionId}-${randomUUID().slice(0, 8)}`;
    await mockRepoStateStore.update(input.repo, (state) => ({ ...state, currentSha: commitSha }));
    return { commitSha, success: true };
  });
}

export async function getCurrentCommitSha(input: ShaCheckInput): Promise<ShaCheckResult> {
  const state = await mockRepoStateStore.get(input.repo);
  return { sha: state.currentSha };
}

export async function checkBranchProtection(
  input: BranchProtectionInput,
): Promise<BranchProtectionResult> {
  const state = await mockRepoStateStore.get(input.repo);
  return {
    satisfied: state.branchProtectionSatisfied,
    reason: state.branchProtectionSatisfied ? undefined : "Branch protection requirements not met",
  };
}

export async function mergePR(input: MergeInput): Promise<void> {
  const key = `${input.missionId}:${input.stepId}:mergePR:v1`;
  await idempotencyStore.runIdempotent(key, "mergePR", async () => {
    // Counted on every real execute() (i.e. every idempotency-cache miss),
    // independent of which branch below runs — see PASS-13, which asserts
    // on this and mergeEffectCount directly rather than trusting a
    // final-state comparison that two duplicate merges could satisfy
    // identically.
    await mockRepoStateStore.update(input.repo, (current) => ({
      ...current,
      mergeAttemptCount: current.mergeAttemptCount + 1,
    }));

    // Reconcile against the external system before trusting our own cache:
    // if it's already merged with this exact SHA, this is a harmless retry.
    const state = await mockRepoStateStore.get(input.repo);
    if (state.isMerged) {
      if (state.mergedSha !== input.expectedSha) {
        throw new Error(
          `Mission ${input.missionId}: repo ${input.repo} already merged at ${state.mergedSha}, expected ${input.expectedSha}`,
        );
      }
      return { merged: true, sha: state.mergedSha };
    }

    if (state.currentSha !== input.expectedSha) {
      throw new Error(
        `Mission ${input.missionId}: HEAD SHA changed since approval (expected ${input.expectedSha}, got ${state.currentSha})`,
      );
    }

    await mockRepoStateStore.update(input.repo, (current) => ({
      ...current,
      isMerged: true,
      mergedSha: input.expectedSha,
      mergeEffectCount: current.mergeEffectCount + 1,
    }));

    // PASS-13: held open *after* the mock mutation (the "GitHub accepted
    // the merge" moment) but before this Activity reports back, so a kill
    // here lands in the exact window where the external effect already
    // happened but Temporal hasn't durably recorded completion yet. The
    // reconciliation check above (`state.isMerged`) is what makes the
    // retry safe: it finds the merge already done and returns without
    // re-mutating, rather than erroring or merging twice.
    await heartbeatingDelay(input.scenario?.mergeDelayMs ?? 0);

    return { merged: true, sha: input.expectedSha };
  });
}

export async function notifyBenny(input: NotifyInput): Promise<void> {
  const key = `${input.missionId}:${input.stepId}:${input.type}:notifyBenny:v1`;
  await idempotencyStore.runIdempotent(key, "notifyBenny", async () => {
    // Phase 1 mock: no real notification channel, just a durable record
    // that the notification was sent, keyed for idempotent retries.
    return { sent: true, at: new Date().toISOString() };
  });
}
