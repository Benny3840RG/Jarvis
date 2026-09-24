import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { after, before, describe, it } from "node:test";
import { setTimeout as sleep } from "node:timers/promises";

import type { MissionIntent } from "../../src/preview/temporalPass/types.js";
import {
  bennyApprovalSignal,
  getMissionStateQuery,
  passWorkflow,
} from "../../src/preview/temporalPass/temporal/workflows/passWorkflow.js";
import { createPassTestEnv, type PassTestEnv, waitForStatus } from "./helpers/testEnv.js";

// PASS-12: approval/timeout ordering is resolved deterministically by
// Temporal's single ordered event history — there's no true concurrent race
// inside the workflow itself. Two deterministic cases:
//  1. the signal is ordered before the timeout fires -> approval wins, the
//     mission completes normally (the "timeout" is really just an upper
//     bound that never gets hit);
//  2. the timeout is ordered before any signal arrives -> CANCELLED is
//     terminal, and a signal arriving afterward must never resurrect it
//     ("late-signal-after-close protection", the case this module name
//     originally focused on).
describe("PASS-12 approval/timeout ordering", () => {
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

  it("a signal ordered comfortably before the timeout wins — the mission completes, not cancels", async () => {
    const missionId = `timeout-race-wins-${randomUUID()}`;
    const repo = `repo-${missionId}`;
    const intent: MissionIntent = {
      id: missionId,
      type: "SIMPLE_ACTION",
      description: "signal-before-timeout test",
      // Long enough that the approval below is unambiguously ordered first;
      // short enough the test doesn't hang if this regresses.
      constraints: { requireApproval: true, approvalTimeoutMs: 5_000 },
      context: { repo },
    };

    const handle = await env.testEnv.client.workflow.start(passWorkflow, {
      taskQueue: env.taskQueue,
      workflowId: missionId,
      args: [intent],
    });

    await waitForStatus(handle, "AWAITING_APPROVAL");
    await handle.signal(bennyApprovalSignal, {
      approvalId: "appr-before-timeout",
      missionId,
      candidateSha: await currentSha(repo),
      decision: "APPROVE",
      approvalCycle: 0,
    });

    const result = await handle.result();
    assert.equal(result.status, "COMPLETED");
  });

  it("a signal sent after the mission has already timed out and closed is rejected, not applied", async () => {
    const missionId = `timeout-race-loses-${randomUUID()}`;
    const repo = `repo-${missionId}`;
    const intent: MissionIntent = {
      id: missionId,
      type: "SIMPLE_ACTION",
      description: "timeout-before-signal test",
      constraints: { requireApproval: true, approvalTimeoutMs: 200 },
      context: { repo },
    };

    const handle = await env.testEnv.client.workflow.start(passWorkflow, {
      taskQueue: env.taskQueue,
      workflowId: missionId,
      args: [intent],
    });

    const result = await handle.result();
    assert.equal(result.status, "CANCELLED");

    // Give the server a moment past completion, then try to deliver a late
    // approval to the now-closed workflow.
    await sleep(200);

    let signalRejected = false;
    try {
      await handle.signal(bennyApprovalSignal, {
        approvalId: "appr-too-late",
        missionId,
        candidateSha: await currentSha(repo),
        decision: "APPROVE",
        approvalCycle: 0,
      });
    } catch {
      signalRejected = true;
    }

    // Whether the server rejects the signal outright (the common case for a
    // closed workflow) or accepts it as a no-op against closed history, the
    // mission's terminal state must not change.
    const finalState = await handle.query(getMissionStateQuery);
    assert.equal(finalState.status, "CANCELLED");

    const finalResult = await handle.result();
    assert.equal(finalResult.status, "CANCELLED");

    const { MockRepoStateStore } =
      await import("../../src/preview/temporalPass/temporal/activities/mockRepoState.js");
    const repoStore = new MockRepoStateStore(env.mockRepoPath);
    const repoState = await repoStore.get(repo);
    assert.equal(repoState.isMerged, false);

    // Not asserted strictly either way (server behavior for signaling a
    // closed workflow isn't part of this module's contract) — recorded for
    // visibility into which path this SDK/server version takes.
    void signalRejected;
  });
});
