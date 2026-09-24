import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { after, before, describe, it } from "node:test";

import type { MissionIntent } from "../../src/preview/temporalPass/types.js";
import { passWorkflow } from "../../src/preview/temporalPass/temporal/workflows/passWorkflow.js";
import { createPassTestEnv, type PassTestEnv } from "./helpers/testEnv.js";

// PASS-05: activities don't duplicate side effects. Temporal's at-least-once
// Activity execution means `mergePR` can legitimately run more than once for
// the same step (e.g. after a worker crash mid-execution — see PASS-01); the
// property that must hold is that the *external* effect (the mock repo
// getting merged) happens exactly once, not that the function body only
// ever executes once.
describe("PASS-05 idempotent side effects", () => {
  let env: PassTestEnv;

  before(async () => {
    env = await createPassTestEnv();
  });

  after(async () => {
    await env.teardown();
  });

  it("re-executing mergePR for an already-merged step is a no-op, not a duplicate merge", async () => {
    const missionId = `side-effect-${randomUUID()}`;
    const repo = `repo-${missionId}`;
    const intent: MissionIntent = {
      id: missionId,
      type: "SIMPLE_ACTION",
      description: "side effect idempotency test",
      context: { repo },
    };

    const handle = await env.testEnv.client.workflow.start(passWorkflow, {
      taskQueue: env.taskQueue,
      workflowId: missionId,
      args: [intent],
    });
    const result = await handle.result();
    assert.equal(result.status, "COMPLETED");

    const { mergePR } =
      await import("../../src/preview/temporalPass/temporal/activities/mockPassActivities.js");
    const { MockRepoStateStore } =
      await import("../../src/preview/temporalPass/temporal/activities/mockRepoState.js");
    const { IdempotencyStore } =
      await import("../../src/preview/temporalPass/idempotency/idempotencyStore.js");
    const repoStore = new MockRepoStateStore(env.mockRepoPath);
    const idempotencyStore = new IdempotencyStore(env.idempotencyPath);

    const afterFirstMerge = await repoStore.get(repo);
    assert.equal(afterFirstMerge.isMerged, true);
    assert.equal(afterFirstMerge.mergeEffectCount, 1);
    const mergedSha = afterFirstMerge.mergedSha;
    assert.ok(mergedSha);

    // Reusing the same missionId/stepId here would just hit the idempotency
    // store's own "completed" cache and return without ever calling
    // execute() again — proving nothing about reconciliation. To actually
    // exercise "the Activity completion was lost from Temporal's point of
    // view, but the external effect already happened" (the real
    // at-least-once scenario this test is about), clear that cache entry
    // back to "pending" while leaving the mock repo's merged state alone,
    // then re-invoke mergePR so it falls through to execute() and has to
    // reconcile against the already-merged external state itself.
    const key = `${missionId}:merge:mergePR:v1`;
    const cachedEntry = await idempotencyStore.get(key);
    assert.ok(cachedEntry, "expected a completed idempotency entry from the first merge");
    await idempotencyStore.set(key, { ...cachedEntry, state: "pending" });

    await mergePR({
      missionId,
      stepId: "merge",
      repo,
      prNumber: 1,
      expectedSha: mergedSha,
    });

    const afterRetry = await repoStore.get(repo);
    assert.equal(afterRetry.isMerged, true);
    assert.equal(afterRetry.mergedSha, mergedSha);
    // The real proof of "no duplicate side effect": the effect counter must
    // still read 1, not 2, even though execute() genuinely ran a second time.
    assert.equal(afterRetry.mergeEffectCount, 1);
    assert.equal(afterRetry.mergeAttemptCount, 2);
  });
});
