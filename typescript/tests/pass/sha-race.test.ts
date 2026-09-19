import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { after, before, describe, it } from "node:test";

import type { MissionIntent } from "../../src/preview/temporalPass/types.js";
import {
  bennyApprovalSignal,
  passWorkflow,
} from "../../src/preview/temporalPass/temporal/workflows/passWorkflow.js";
import { createPassTestEnv, type PassTestEnv, waitForStatus } from "./helpers/testEnv.js";

// PASS-09: a changed HEAD after approval cannot merge. Benny approves commit
// A; before the mission acts on that approval, a new commit B lands on the
// branch (simulated here by mutating the mock repo directly, the same way
// an out-of-band `git push` would change GitHub's HEAD). The mission must
// fail closed instead of merging B under an approval that was only ever
// granted for A.
describe("PASS-09 SHA changed after approval", () => {
  let env: PassTestEnv;

  before(async () => {
    env = await createPassTestEnv();
  });

  after(async () => {
    await env.teardown();
  });

  it("fails closed when HEAD moves after approval but before merge", async () => {
    const missionId = `sha-race-${randomUUID()}`;
    const repo = `repo-${missionId}`;
    const intent: MissionIntent = {
      id: missionId,
      type: "SIMPLE_ACTION",
      description: "sha race test",
      constraints: { requireApproval: true },
      context: { repo },
    };

    const handle = await env.testEnv.client.workflow.start(passWorkflow, {
      taskQueue: env.taskQueue,
      workflowId: missionId,
      args: [intent],
    });

    await waitForStatus(handle, "AWAITING_APPROVAL");

    const { MockRepoStateStore } =
      await import("../../src/preview/temporalPass/temporal/activities/mockRepoState.js");
    const repoStore = new MockRepoStateStore(env.mockRepoPath);

    // Simulate an out-of-band commit landing on the branch after Benny has
    // seen (but not yet acted on) the candidate that was actually approved.
    await repoStore.update(repo, (state) => ({ ...state, currentSha: "race-condition-sha" }));

    await handle.signal(bennyApprovalSignal, {
      approvalId: "appr-1",
      missionId,
      candidateSha: "n/a",
      decision: "APPROVE",
      approvalCycle: 0,
    });

    const result = await handle.result();
    assert.equal(result.status, "FAILED");
    assert.equal(result.failedStep, "SHA_VERIFICATION");
    assert.ok(!result.completedSteps.includes("MERGE"));

    const repoState = await repoStore.get(repo);
    assert.equal(repoState.isMerged, false);
  });
});
