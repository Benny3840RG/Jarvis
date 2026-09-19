import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { after, before, describe, it } from "node:test";

import type { MissionIntent } from "../../src/preview/temporalPass/types.js";
import {
  bennyApprovalSignal,
  passWorkflow,
} from "../../src/preview/temporalPass/temporal/workflows/passWorkflow.js";
import { createPassTestEnv, type PassTestEnv, waitForStatus } from "./helpers/testEnv.js";

// PASS-08: a rejected approval cannot merge.
describe("PASS-08 rejected approval cannot merge", () => {
  let env: PassTestEnv;

  before(async () => {
    env = await createPassTestEnv();
  });

  after(async () => {
    await env.teardown();
  });

  it("REJECT terminates the mission without merging", async () => {
    const missionId = `rejection-${randomUUID()}`;
    const repo = `repo-${missionId}`;
    const intent: MissionIntent = {
      id: missionId,
      type: "SIMPLE_ACTION",
      description: "rejection test",
      constraints: { requireApproval: true },
      context: { repo },
    };

    const handle = await env.testEnv.client.workflow.start(passWorkflow, {
      taskQueue: env.taskQueue,
      workflowId: missionId,
      args: [intent],
    });

    await waitForStatus(handle, "AWAITING_APPROVAL");

    await handle.signal(bennyApprovalSignal, {
      approvalId: "appr-1",
      missionId,
      candidateSha: "n/a",
      decision: "REJECT",
      approvalCycle: 0,
      reasoning: "not ready",
    });

    const result = await handle.result();
    assert.equal(result.status, "REJECTED");
    assert.equal(result.failedStep, "BENNY_APPROVAL");
    assert.ok(!result.completedSteps.includes("MERGE"));

    const { MockRepoStateStore } =
      await import("../../src/preview/temporalPass/temporal/activities/mockRepoState.js");
    const repoStore = new MockRepoStateStore(env.mockRepoPath);
    const repoState = await repoStore.get(repo);
    assert.equal(repoState.isMerged, false);
  });
});
