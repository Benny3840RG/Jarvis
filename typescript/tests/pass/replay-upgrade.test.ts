import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import path from "node:path";
import { after, before, describe, it } from "node:test";
import { fileURLToPath } from "node:url";

import type { WorkflowHandle } from "@temporalio/client";
import { Worker } from "@temporalio/worker";

import type { MissionIntent } from "../../src/preview/temporalPass/types.js";
import { passWorkflow } from "../../src/preview/temporalPass/temporal/workflows/passWorkflow.js";
import { createPassTestEnv, type PassTestEnv, waitForStatus } from "./helpers/testEnv.js";

type MissionHistory = Awaited<ReturnType<WorkflowHandle<typeof passWorkflow>["fetchHistory"]>>;

const dirname = path.dirname(fileURLToPath(import.meta.url));
const REAL_WORKFLOW_PATH = path.resolve(
  dirname,
  "../../src/preview/temporalPass/temporal/workflows/passWorkflow.ts",
);
const BROKEN_FIXTURE_PATH = path.resolve(dirname, "fixtures/brokenReplayWorkflow.ts");

// PASS-14: a workflow-code upgrade landing while a mission is parked at
// AWAITING_APPROVAL (which can wait up to 72h — plenty of time for a real
// Jarvis deploy to happen underneath it) must not silently corrupt that
// mission's history. We capture a real, in-flight history from a mission
// still waiting on approval, then feed it to Temporal's own replay/
// determinism checker (`Worker.runReplayHistory`) against two different
// workflow-code versions: the current file (must replay cleanly — the
// ongoing regression guard for any future edit to passWorkflow.ts) and a
// deliberately incompatible fixture (must be rejected — proof this test
// methodology actually catches breakage, not a vacuous "it didn't throw").
describe("PASS-14 workflow-code upgrade replay safety", () => {
  let env: PassTestEnv;
  let history: MissionHistory;

  before(async () => {
    env = await createPassTestEnv();

    const missionId = `replay-upgrade-${randomUUID()}`;
    const intent: MissionIntent = {
      id: missionId,
      type: "SIMPLE_ACTION",
      description: "replay upgrade test",
      constraints: { requireApproval: true },
      context: { repo: `repo-${missionId}` },
    };

    const handle = await env.testEnv.client.workflow.start(passWorkflow, {
      taskQueue: env.taskQueue,
      workflowId: missionId,
      args: [intent],
    });

    // Capture the history while the mission is still genuinely parked
    // mid-flight, not after it completes.
    await waitForStatus(handle, "AWAITING_APPROVAL");
    history = await handle.fetchHistory();
  });

  after(async () => {
    await env.teardown();
  });

  it("replays cleanly against the current (unmodified) workflow code", async () => {
    await Worker.runReplayHistory({ workflowsPath: REAL_WORKFLOW_PATH }, history);
  });

  it("rejects a workflow-code version whose command sequence no longer matches the captured history", async () => {
    await assert.rejects(() =>
      Worker.runReplayHistory({ workflowsPath: BROKEN_FIXTURE_PATH }, history),
    );
  });
});
