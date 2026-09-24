import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { after, before, describe, it } from "node:test";
import { setTimeout as sleep } from "node:timers/promises";

import type { ApprovalResponse, MissionIntent } from "../../src/preview/temporalPass/types.js";
import {
  bennyApprovalSignal,
  getMissionStateQuery,
  passWorkflow,
} from "../../src/preview/temporalPass/temporal/workflows/passWorkflow.js";
import { createPassTestEnv, type PassTestEnv, waitForStatus } from "./helpers/testEnv.js";

// PASS-04: duplicate/stale approval signals are handled harmlessly.
describe("PASS-04 duplicate approval signals", () => {
  let env: PassTestEnv;

  before(async () => {
    env = await createPassTestEnv();
  });

  after(async () => {
    await env.teardown();
  });

  async function currentSha(repo: string): Promise<string> {
    const { MockRepoStateStore } =
      await import("../../src/preview/temporalPass/temporal/activities/mockRepoState.js");
    const repoStore = new MockRepoStateStore(env.mockRepoPath);
    return (await repoStore.get(repo)).currentSha;
  }

  it("an exact duplicate of the applied response is a harmless no-op", async () => {
    const missionId = `dup-exact-${randomUUID()}`;
    const repo = `repo-${missionId}`;
    const intent: MissionIntent = {
      id: missionId,
      type: "SIMPLE_ACTION",
      description: "duplicate signal test",
      constraints: { requireApproval: true },
      context: { repo },
    };

    const handle = await env.testEnv.client.workflow.start(passWorkflow, {
      taskQueue: env.taskQueue,
      workflowId: missionId,
      args: [intent],
    });

    await waitForStatus(handle, "AWAITING_APPROVAL");

    const approval: ApprovalResponse = {
      approvalId: "appr-1",
      missionId,
      candidateSha: await currentSha(repo),
      decision: "APPROVE",
      approvalCycle: 0,
    };

    await handle.signal(bennyApprovalSignal, approval);
    await handle.signal(bennyApprovalSignal, approval); // exact duplicate

    const result = await handle.result();
    assert.equal(result.status, "COMPLETED");
  });

  it("a stale signal for a superseded approval cycle is ignored, not applied", async () => {
    const missionId = `dup-stale-${randomUUID()}`;
    const repo = `repo-${missionId}`;
    const intent: MissionIntent = {
      id: missionId,
      type: "SIMPLE_ACTION",
      description: "stale cycle signal test",
      constraints: { requireApproval: true },
      context: { repo },
    };

    const handle = await env.testEnv.client.workflow.start(passWorkflow, {
      taskQueue: env.taskQueue,
      workflowId: missionId,
      args: [intent],
    });

    await waitForStatus(handle, "AWAITING_APPROVAL");
    const firstSha = await currentSha(repo);

    // MODIFY advances the mission to approval cycle 1.
    await handle.signal(bennyApprovalSignal, {
      approvalId: "appr-1",
      missionId,
      candidateSha: firstSha,
      decision: "MODIFY",
      approvalCycle: 0,
      modifications: { feedback: "please adjust" },
    });

    await waitForStatus(handle, "AWAITING_APPROVAL");
    const secondSha = await currentSha(repo);

    // A late/stale response to the *original* (cycle 0) request must not be
    // applied now that the mission is waiting on cycle 1. Note it even
    // carries the *original* candidateSha, matching what that stale
    // approval would legitimately have referenced.
    await handle.signal(bennyApprovalSignal, {
      approvalId: "appr-1-late",
      missionId,
      candidateSha: firstSha,
      decision: "REJECT",
      approvalCycle: 0,
    });

    // Give the (ignored) signal a moment to be processed, then confirm the
    // mission is still waiting rather than having been wrongly rejected.
    await sleep(300);
    const stillWaiting = await handle.query(getMissionStateQuery);
    assert.equal(stillWaiting.status, "AWAITING_APPROVAL");

    await handle.signal(bennyApprovalSignal, {
      approvalId: "appr-2",
      missionId,
      candidateSha: secondSha,
      decision: "APPROVE",
      approvalCycle: 1,
    });

    const result = await handle.result();
    assert.equal(result.status, "COMPLETED");
  });
});
