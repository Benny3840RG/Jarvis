import { randomUUID } from "node:crypto";
import os from "node:os";
import path from "node:path";
import { setTimeout as sleep } from "node:timers/promises";
import { fileURLToPath } from "node:url";

import type { WorkflowHandle } from "@temporalio/client";
import { TestWorkflowEnvironment } from "@temporalio/testing";
import { Worker } from "@temporalio/worker";

import type { MissionState } from "../../../src/preview/temporalPass/types.js";
import {
  getMissionStateQuery,
  type passWorkflow,
} from "../../../src/preview/temporalPass/temporal/workflows/passWorkflow.js";

const dirname = path.dirname(fileURLToPath(import.meta.url));
const passPreviewDir = path.resolve(dirname, "../../../src/preview/temporalPass");

export interface PassTestEnv {
  testEnv: TestWorkflowEnvironment;
  worker: Worker;
  taskQueue: string;
  idempotencyPath: string;
  mockRepoPath: string;
  teardown: () => Promise<void>;
}

/**
 * Tier 1 setup: a real ephemeral local Temporal server + a real in-process
 * Worker, both torn down at the end of the test. Real wall-clock time (this
 * SDK's `createLocal()` never time-skips) — fine for everything except the
 * 72h approval default, which tests override via
 * `MissionIntent.constraints.approvalTimeoutMs`.
 *
 * The activities module is imported *dynamically*, after the
 * `TEMPORAL_PASS_IDEMPOTENCY_PATH`/`TEMPORAL_PASS_MOCK_REPO_PATH` env vars
 * are set here — a static top-level `import` would be hoisted above any
 * `process.env` assignment a test file makes, so the activities module
 * would always read the unset (default, repo-shared) path. Routing it
 * through this one function gives every test file its own isolated,
 * temp-file-backed idempotency/mock-repo state without each file having to
 * remember the dynamic-import dance itself.
 */
export async function createPassTestEnv(): Promise<PassTestEnv> {
  const runId = randomUUID();
  const idempotencyPath = path.join(os.tmpdir(), `temporal-pass-idempotency-${runId}.json`);
  const mockRepoPath = path.join(os.tmpdir(), `temporal-pass-mock-repo-${runId}.json`);
  process.env.TEMPORAL_PASS_IDEMPOTENCY_PATH = idempotencyPath;
  process.env.TEMPORAL_PASS_MOCK_REPO_PATH = mockRepoPath;

  const mockPassActivities =
    await import("../../../src/preview/temporalPass/temporal/activities/mockPassActivities.js");

  const testEnv = await TestWorkflowEnvironment.createLocal();
  const taskQueue = `temporal-pass-test-${runId}`;

  const worker = await Worker.create({
    connection: testEnv.nativeConnection,
    taskQueue,
    workflowsPath: path.join(passPreviewDir, "temporal/workflows/passWorkflow.ts"),
    activities: mockPassActivities,
  });

  const runPromise = worker.run();

  return {
    testEnv,
    worker,
    taskQueue,
    idempotencyPath,
    mockRepoPath,
    async teardown() {
      worker.shutdown();
      await runPromise;
      await testEnv.teardown();
    },
  };
}

/** Polls `getMissionState` until it reports `status`, or throws after `timeoutMs`. */
export async function waitForStatus(
  handle: WorkflowHandle<typeof passWorkflow>,
  status: MissionState["status"],
  timeoutMs = 5_000,
): Promise<MissionState> {
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    const state = await handle.query(getMissionStateQuery);
    if (state.status === status) return state;
    await sleep(50);
  }
  throw new Error(`Timed out waiting for mission status "${status}"`);
}
