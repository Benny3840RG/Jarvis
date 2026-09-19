import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { after, before, describe, it } from "node:test";

import { Client, Connection } from "@temporalio/client";

import {
  bennyApprovalSignal,
  getMissionStateQuery,
  passWorkflow,
} from "../../src/preview/temporalPass/temporal/workflows/passWorkflow.js";
import { ProcessHarness } from "./helpers/processHarness.js";
import { waitForStatus } from "./helpers/testEnv.js";

// PASS-03: an approval wait survives a full reboot. The mission reaches
// AWAITING_APPROVAL, then both the server and worker processes are killed
// and restarted (same simulation as PASS-02), and only *after* that does
// Benny's approval signal arrive — proving the workflow's pending
// `condition()` wait and signal handler are correctly reconstructed from
// persisted history, not just "still running in a process that happened not
// to die."
describe("PASS-03 approval wait survives a reboot", () => {
  let harness: ProcessHarness;
  let client: Client;

  async function connectClient(address: string): Promise<Client> {
    const connection = await Connection.connect({ address });
    return new Client({ connection, namespace: "default" });
  }

  before(async () => {
    harness = new ProcessHarness();
    await harness.startServer();
    await harness.startWorker();
    client = await connectClient(harness.address);
  });

  after(async () => {
    await client?.connection.close();
    await harness.teardown();
  });

  it("accepts the approval signal after a reboot and completes the mission", async () => {
    const missionId = `approval-recovery-${randomUUID()}`;
    const repo = `repo-${missionId}`;

    const handle = await client.workflow.start(passWorkflow, {
      taskQueue: harness.taskQueue,
      workflowId: missionId,
      args: [
        {
          id: missionId,
          type: "SIMPLE_ACTION",
          description: "approval recovery test",
          constraints: { requireApproval: true },
          context: { repo },
        },
      ],
    });

    await waitForStatus(handle, "AWAITING_APPROVAL");

    harness.killWorker();
    harness.killServer();
    await client.connection.close();

    await harness.startServer();
    client = await connectClient(harness.address);
    await harness.startWorker();

    const rebootedHandle = client.workflow.getHandle(missionId);
    const stateAfterReboot = await rebootedHandle.query(getMissionStateQuery);
    assert.equal(stateAfterReboot.status, "AWAITING_APPROVAL");

    await rebootedHandle.signal(bennyApprovalSignal, {
      approvalId: "appr-post-reboot",
      missionId,
      candidateSha: "n/a",
      decision: "APPROVE",
      approvalCycle: 0,
    });

    const result = await rebootedHandle.result();
    assert.equal(result.status, "COMPLETED");

    const { MockRepoStateStore } =
      await import("../../src/preview/temporalPass/temporal/activities/mockRepoState.js");
    const repoStore = new MockRepoStateStore(harness.mockRepoPath);
    const repoState = await repoStore.get(repo);
    assert.equal(repoState.isMerged, true);
  });
});
