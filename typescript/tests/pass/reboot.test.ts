import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { after, before, describe, it } from "node:test";
import { setTimeout as sleep } from "node:timers/promises";

import { Client, Connection } from "@temporalio/client";

import { passWorkflow } from "../../src/preview/temporalPass/temporal/workflows/passWorkflow.js";
import { ProcessHarness } from "./helpers/processHarness.js";

// PASS-02: the mission survives a full "Jarvis reboot" — both the Temporal
// server *and* the worker process die and come back, sharing the same
// on-disk `--db-filename` SQLite store and the same idempotency/mock-repo
// JSON files. This is a genuine process-level reboot simulation, not an
// in-process stand-in: history replay comes from the server reloading its
// persisted event history from disk, not from anything held in this test's
// memory.
describe("PASS-02 survives a full server+worker reboot", () => {
  let harness: ProcessHarness;
  let client: Client;

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

  async function connectClient(address: string): Promise<Client> {
    const connection = await Connection.connect({ address });
    return new Client({ connection, namespace: "default" });
  }

  it("completes after both the server and the worker restart mid-mission", async () => {
    const missionId = `reboot-${randomUUID()}`;
    const repo = `repo-${missionId}`;

    await client.workflow.start(passWorkflow, {
      taskQueue: harness.taskQueue,
      workflowId: missionId,
      args: [
        {
          id: missionId,
          type: "SIMPLE_ACTION",
          description: "reboot test",
          context: { repo },
          scenario: { buildDelayMs: 4_000 },
        },
      ],
    });

    await sleep(750);

    // Simulate a full machine reboot: both processes die, then both come
    // back pointed at the same persisted state.
    harness.killWorker();
    harness.killServer();
    await client.connection.close();

    await harness.startServer();
    client = await connectClient(harness.address);
    await harness.startWorker();

    const rebootedHandle = client.workflow.getHandle(missionId);
    const result = await rebootedHandle.result();
    assert.equal(result.status, "COMPLETED");

    const { MockRepoStateStore } =
      await import("../../src/preview/temporalPass/temporal/activities/mockRepoState.js");
    const repoStore = new MockRepoStateStore(harness.mockRepoPath);
    const repoState = await repoStore.get(repo);
    assert.equal(repoState.isMerged, true);
  });
});
