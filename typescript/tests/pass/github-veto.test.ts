import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { after, before, describe, it } from "node:test";

import type { MissionIntent } from "../../src/preview/temporalPass/types.js";
import { passWorkflow } from "../../src/preview/temporalPass/temporal/workflows/passWorkflow.js";
import { createPassTestEnv, type PassTestEnv } from "./helpers/testEnv.js";

// PASS-10: GitHub branch protection can still veto Jarvis, independent of
// (and after) any approval decision. A real branch-protection rule (e.g.
// "no direct pushes", a missing required check) can block a merge even when
// everyone in the loop already agreed to it.
describe("PASS-10 branch protection veto", () => {
  let env: PassTestEnv;

  before(async () => {
    env = await createPassTestEnv();
  });

  after(async () => {
    await env.teardown();
  });

  it("fails closed at the branch-protection check even with no pending approval issues", async () => {
    const missionId = `github-veto-${randomUUID()}`;
    const repo = `repo-${missionId}`;

    const { MockRepoStateStore } =
      await import("../../src/preview/temporalPass/temporal/activities/mockRepoState.js");
    const repoStore = new MockRepoStateStore(env.mockRepoPath);
    await repoStore.update(repo, (state) => ({ ...state, branchProtectionSatisfied: false }));

    const intent: MissionIntent = {
      id: missionId,
      type: "SIMPLE_ACTION",
      description: "branch protection veto test",
      context: { repo },
    };

    const handle = await env.testEnv.client.workflow.start(passWorkflow, {
      taskQueue: env.taskQueue,
      workflowId: missionId,
      args: [intent],
    });
    const result = await handle.result();

    assert.equal(result.status, "FAILED");
    assert.equal(result.failedStep, "BRANCH_PROTECTION");
    assert.ok(!result.completedSteps.includes("MERGE"));

    const repoState = await repoStore.get(repo);
    assert.equal(repoState.isMerged, false);
  });
});
