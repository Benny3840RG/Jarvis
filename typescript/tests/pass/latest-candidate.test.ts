import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { after, before, describe, it } from "node:test";

import type { MissionIntent } from "../../src/preview/temporalPass/types.js";
import { passWorkflow } from "../../src/preview/temporalPass/temporal/workflows/passWorkflow.js";
import { createPassTestEnv, type PassTestEnv } from "./helpers/testEnv.js";

// PASS-06: rework uses the newest candidate. If MERGE used the *original*
// build's SHA instead of the reworked one, this would fail: the mock repo
// only ever holds one `currentSha`/`mergedSha`, and every rework overwrites
// it, so a merge against a stale build would be a SHA mismatch.
describe("PASS-06 rework uses the latest candidate", () => {
  let env: PassTestEnv;

  before(async () => {
    env = await createPassTestEnv();
  });

  after(async () => {
    await env.teardown();
  });

  it("merges the reworked build, not the original one that needed changes", async () => {
    const missionId = `latest-candidate-${randomUUID()}`;
    const repo = `repo-${missionId}`;
    const intent: MissionIntent = {
      id: missionId,
      type: "SIMPLE_ACTION",
      description: "latest candidate test",
      context: { repo },
      scenario: { reviewChangesForCycles: 1 },
    };

    const handle = await env.testEnv.client.workflow.start(passWorkflow, {
      taskQueue: env.taskQueue,
      workflowId: missionId,
      args: [intent],
    });
    const result = await handle.result();

    assert.equal(result.status, "COMPLETED");
    assert.equal(result.iteration, 1);
    assert.ok(result.completedSteps.includes("REVIEW"));

    const { MockRepoStateStore } =
      await import("../../src/preview/temporalPass/temporal/activities/mockRepoState.js");
    const repoStore = new MockRepoStateStore(env.mockRepoPath);
    const finalState = await repoStore.get(repo);

    assert.equal(finalState.isMerged, true);
    assert.match(finalState.mergedSha ?? "", /^rework-/);
  });
});
