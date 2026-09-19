import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { after, before, describe, it } from "node:test";
import { setTimeout as sleep } from "node:timers/promises";

import { Client, Connection } from "@temporalio/client";

import { passWorkflow } from "../../src/preview/temporalPass/temporal/workflows/passWorkflow.js";
import { ProcessHarness } from "./helpers/processHarness.js";

// PASS-01: the mission survives a worker process crash. A build Activity is
// held open (heartbeating) via `scenario.buildDelayMs` so the SIGKILL lands
// while it's genuinely in flight, not racing a near-instant mock. Temporal
// notices the dead worker via the missed heartbeat (`heartbeatTimeout: '2
// seconds'` on `executeBuild`), and a freshly started worker on the same
// task queue picks the retry up and finishes the mission.
describe("PASS-01 survives a worker process kill", () => {
  let harness: ProcessHarness;
  let client: Client;

  before(async () => {
    harness = new ProcessHarness();
    await harness.startServer();
    await harness.startWorker();
    const connection = await Connection.connect({ address: harness.address });
    client = new Client({ connection, namespace: "default" });
  });

  after(async () => {
    await client?.connection.close();
    await harness.teardown();
  });

  it("completes after the worker is killed mid-build and a new worker takes over", async () => {
    const missionId = `worker-kill-${randomUUID()}`;
    const repo = `repo-${missionId}`;

    const handle = await client.workflow.start(passWorkflow, {
      taskQueue: harness.taskQueue,
      workflowId: missionId,
      args: [
        {
          id: missionId,
          type: "SIMPLE_ACTION",
          description: "worker kill test",
          context: { repo },
          scenario: { buildDelayMs: 4_000 },
        },
      ],
    });

    // Give the build Activity time to actually start (and heartbeat once)
    // before pulling the rug out from under it.
    await sleep(750);
    harness.killWorker();
    await harness.startWorker();

    const result = await handle.result();
    assert.equal(result.status, "COMPLETED");

    const { IdempotencyStore } =
      await import("../../src/preview/temporalPass/idempotency/idempotencyStore.js");
    const { MockRepoStateStore } =
      await import("../../src/preview/temporalPass/temporal/activities/mockRepoState.js");
    const idempotencyStore = new IdempotencyStore(harness.idempotencyPath);
    const repoStore = new MockRepoStateStore(harness.mockRepoPath);

    const buildEntry = await idempotencyStore.get(`${missionId}:build:executeBuild:v1`);
    assert.equal(buildEntry?.state, "completed");
    const builtSha = (buildEntry?.result as { commitSha: string }).commitSha;

    const repoState = await repoStore.get(repo);
    assert.equal(repoState.isMerged, true);
    // If the interrupted attempt's crash had raced a duplicate,
    // uncoordinated side effect, this would diverge from what the
    // idempotency store recorded as *the* build result.
    assert.equal(repoState.mergedSha, builtSha);
  });
});
