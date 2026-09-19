import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import path from "node:path";
import { after, before, describe, it } from "node:test";
import { setTimeout as sleep } from "node:timers/promises";
import { fileURLToPath } from "node:url";

import type { WorkflowHandle } from "@temporalio/client";
import { Worker } from "@temporalio/worker";

import type { MissionIntent, MissionState } from "../../src/preview/temporalPass/types.js";
import { getMissionStateQuery } from "../../src/preview/temporalPass/temporal/workflows/passWorkflow.js";
import { passWorkflow as pinnedPassWorkflow } from "./fixtures/pinnedPassWorkflowV1.js";
import { createPassTestEnv, type PassTestEnv } from "./helpers/testEnv.js";

const dirname = path.dirname(fileURLToPath(import.meta.url));
const REAL_WORKFLOW_PATH = path.resolve(
  dirname,
  "../../src/preview/temporalPass/temporal/workflows/passWorkflow.ts",
);
const BROKEN_FIXTURE_PATH = path.resolve(dirname, "fixtures/brokenReplayWorkflow.ts");
const PINNED_WORKFLOW_PATH = path.resolve(dirname, "fixtures/pinnedPassWorkflowV1.ts");

type MissionHistory = Awaited<ReturnType<WorkflowHandle["fetchHistory"]>>;

async function waitForQueryStatus(
  handle: WorkflowHandle,
  status: MissionState["status"],
  timeoutMs = 5_000,
): Promise<void> {
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    const state = await handle.query<MissionState>(getMissionStateQuery);
    if (state.status === status) return;
    await sleep(50);
  }
  throw new Error(`Timed out waiting for mission status "${status}"`);
}

// PASS-14: a workflow-code upgrade landing while a mission is parked at
// AWAITING_APPROVAL (which can wait up to 72h — plenty of time for a real
// Jarvis deploy to happen underneath it) must not silently corrupt that
// mission's history.
//
// The history replayed here comes from running `fixtures/
// pinnedPassWorkflowV1.ts` — a pinned snapshot that never changes — rather
// than the live current `passWorkflow.ts`. That's deliberate: if this test
// instead captured history from current code and replayed it against
// current code in the same run, it would pass vacuously forever (tomorrow's
// edited workflow would just regenerate tomorrow's history and "replay"
// against itself). Pinning the source that *produces* the history is what
// makes a future incompatible edit to the real file something this test can
// actually catch — see the fixture's own docstring for why a frozen JSON
// history blob (the more common Temporal pattern) isn't used here instead.
describe("PASS-14 workflow-code upgrade replay safety", () => {
  let env: PassTestEnv;
  let history: MissionHistory;

  before(async () => {
    env = await createPassTestEnv();

    const activities =
      await import("../../src/preview/temporalPass/temporal/activities/mockPassActivities.js");
    const pinnedTaskQueue = `temporal-pass-pinned-${randomUUID()}`;
    const pinnedWorker = await Worker.create({
      connection: env.testEnv.nativeConnection,
      taskQueue: pinnedTaskQueue,
      workflowsPath: PINNED_WORKFLOW_PATH,
      activities,
    });
    const pinnedRunPromise = pinnedWorker.run();

    try {
      const missionId = `replay-upgrade-${randomUUID()}`;
      const intent: MissionIntent = {
        id: missionId,
        type: "SIMPLE_ACTION",
        description: "replay upgrade test",
        constraints: { requireApproval: true },
        context: { repo: `repo-${missionId}` },
      };

      const handle = await env.testEnv.client.workflow.start(pinnedPassWorkflow, {
        taskQueue: pinnedTaskQueue,
        workflowId: missionId,
        args: [intent],
      });

      // Capture the history while the mission is still genuinely parked
      // mid-flight, not after it completes.
      await waitForQueryStatus(handle, "AWAITING_APPROVAL");
      history = await handle.fetchHistory();
    } finally {
      pinnedWorker.shutdown();
      await pinnedRunPromise;
    }
  });

  after(async () => {
    await env.teardown();
  });

  it("replays cleanly against the current workflow code (forward-compatibility guard)", async () => {
    await Worker.runReplayHistory({ workflowsPath: REAL_WORKFLOW_PATH }, history);
  });

  it("rejects a workflow-code version whose command sequence no longer matches the pinned history", async () => {
    await assert.rejects(() =>
      Worker.runReplayHistory({ workflowsPath: BROKEN_FIXTURE_PATH }, history),
    );
  });
});
