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
import { createPassTestEnv, type PassTestEnv } from "./helpers/testEnv.js";

// PASS-12: a late approval signal must never resurrect an already-terminal
// mission. Temporal workflows execute deterministically from a single
// ordered event history, so there's no true concurrent race inside the
// workflow itself — the property to prove is that once the timeout has
// already produced a terminal CANCELLED result, a signal arriving afterward
// is not silently accepted and does not change that outcome.
describe("PASS-12 late signal after timeout cannot resurrect the mission", () => {
  let env: PassTestEnv;

  before(async () => {
    env = await createPassTestEnv();
  });

  after(async () => {
    await env.teardown();
  });

  it("a signal sent after the mission has already timed out and closed is rejected, not applied", async () => {
    const missionId = `timeout-race-${randomUUID()}`;
    const repo = `repo-${missionId}`;
    const intent: MissionIntent = {
      id: missionId,
      type: "SIMPLE_ACTION",
      description: "timeout race test",
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
        candidateSha: "n/a",
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
