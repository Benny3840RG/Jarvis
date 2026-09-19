import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { after, before, describe, it } from "node:test";

import type { MissionIntent } from "../../src/preview/temporalPass/types.js";
import { passWorkflow } from "../../src/preview/temporalPass/temporal/workflows/passWorkflow.js";
import { createPassTestEnv, type PassTestEnv } from "./helpers/testEnv.js";

// PASS-11: an approval timeout fails closed and merge never executes.
// `TestWorkflowEnvironment.createLocal()` runs on real wall-clock time (it
// never time-skips — only `createTimeSkipping()` does), so this exercises
// the real 72h-default `condition(...)` timeout path with a short override
// via `constraints.approvalTimeoutMs` rather than waiting three real days.
describe("PASS-11 approval timeout", () => {
  let env: PassTestEnv;

  before(async () => {
    env = await createPassTestEnv();
  });

  after(async () => {
    await env.teardown();
  });

  it("cancels the mission if Benny never responds, without merging", async () => {
    const missionId = `approval-timeout-${randomUUID()}`;
    const repo = `repo-${missionId}`;
    const intent: MissionIntent = {
      id: missionId,
      type: "SIMPLE_ACTION",
      description: "approval timeout test",
      constraints: { requireApproval: true, approvalTimeoutMs: 300 },
      context: { repo },
    };

    const handle = await env.testEnv.client.workflow.start(passWorkflow, {
      taskQueue: env.taskQueue,
      workflowId: missionId,
      args: [intent],
    });

    const result = await handle.result();
    assert.equal(result.status, "CANCELLED");
    assert.equal(result.failedStep, "BENNY_APPROVAL");
    assert.match(result.failureReason ?? "", /timeout/i);
    assert.ok(!result.completedSteps.includes("MERGE"));

    const { MockRepoStateStore } =
      await import("../../src/preview/temporalPass/temporal/activities/mockRepoState.js");
    const repoStore = new MockRepoStateStore(env.mockRepoPath);
    const repoState = await repoStore.get(repo);
    assert.equal(repoState.isMerged, false);
  });
});
