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

// Mock REVIEW/TEST decisions must be stable across Activity retries and
// worker restarts. The workflow already gives every logical cycle a stable
// stepId ("review", "review-1", ... / "test", "test-1", ...), so derive the
// scenario ordinal from that durable input instead of process-local counters.
// A retried Activity therefore returns the same decision for the same step.
function logicalCycle(stepId: string, prefix: "review" | "test"): number {
  if (stepId === prefix) return 1;
  const match = stepId.match(new RegExp(`^${prefix}-(\\d+)import { Context } from "@temporalio/activity";
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

));
  if (!match) throw new Error(`Invalid ${prefix} step id: ${stepId}`);
  const cycle = Number(match[1]);
  if (!Number.isSafeInteger(cycle) || cycle < 1)
    throw new Error(`Invalid ${prefix} step id: ${stepId}`);
  return cycle + 1;
}

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

// executeBuild/executeRework/repairTests deliberately do NOT get the same
// atomic check-and-mutate treatment as mergePR, even though they share the
// same "idempotency cache check and execute() are non-atomic" gap: two
// genuinely concurrent executions (a zombie worker racing its replacement)
// could each write a *different* random commitSha, leaving the mock repo's
// currentSha inconsistent with whichever BuildResult a given caller's
// runIdempotent call happens to return. Unlike mergePR, that inconsistency
// can never reach an unsafe outcome here: the independent SHA_VERIFICATION
// step in passWorkflow.ts re-reads getCurrentCommitSha immediately before
// merge and fails closed on any mismatch against what was actually approved
// (PASS-09) — so the worst case is a spurious FAILED mission, never a merge
// of the wrong commit or a duplicated external effect. mergePR's race was
// worth closing because its failure mode was the latter (a duplicate real
// merge); this one's failure mode is already a safe rejection, so it's left
// as the same documented single-host/non-CAS limitation as the rest of
// IdempotencyStore (see idempotencyStore.ts).
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
  const count = logicalCycle(input.stepId, "review");

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
  const count = logicalCycle(input.stepId, "test");

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

    // Reconcile against the external system and apply the merge mutation in
    // a *single* atomic read-modify-write (one `update()` call, one lock
    // acquisition), not a separate get()-then-update(). Two genuinely
    // concurrent executions (e.g. a zombie worker racing its Temporal
    // -rescheduled replacement) could otherwise both read `isMerged: false`
    // before either writes, and both go on to apply the merge effect —
    // exactly the duplicate-external-effect this reconciliation exists to
    // prevent. Folding the check into the mutate callback means the second
    // caller's `update()` only runs after the first's has already committed,
    // so it always observes the post-merge state.
    let alreadyMerged: { merged: true; sha: string } | undefined;
    const nextState = await mockRepoStateStore.update(input.repo, (current) => {
      if (current.isMerged) {
        if (current.mergedSha !== input.expectedSha) {
          throw new Error(
            `Mission ${input.missionId}: repo ${input.repo} already merged at ${current.mergedSha}, expected ${input.expectedSha}`,
          );
        }
        alreadyMerged = { merged: true, sha: current.mergedSha };
        return current;
      }

      if (current.currentSha !== input.expectedSha) {
        throw new Error(
          `Mission ${input.missionId}: HEAD SHA changed since approval (expected ${input.expectedSha}, got ${current.currentSha})`,
        );
      }

      return {
        ...current,
        isMerged: true,
        mergedSha: input.expectedSha,
        mergeEffectCount: current.mergeEffectCount + 1,
      };
    });

    if (alreadyMerged) {
      return alreadyMerged;
    }

    // PASS-13: held open *after* the mock mutation (the "GitHub accepted
    // the merge" moment) but before this Activity reports back, so a kill
    // here lands in the exact window where the external effect already
    // happened but Temporal hasn't durably recorded completion yet. The
    // reconciliation above is what makes the retry safe: it finds the merge
    // already done and returns without re-mutating, rather than erroring or
    // merging twice.
    await heartbeatingDelay(input.scenario?.mergeDelayMs ?? 0);

    return { merged: true, sha: nextState.mergedSha as string };
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
