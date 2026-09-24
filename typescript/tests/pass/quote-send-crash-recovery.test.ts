import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { after, before, describe, it } from "node:test";
import { setTimeout as sleep } from "node:timers/promises";

import { Client, Connection } from "@temporalio/client";

import { MockRepoStateStore } from "../../src/preview/temporalPass/temporal/activities/mockRepoState.js";
import {
  GOVERNED_QUOTE_SEND_ACCEPT_DELAY_ENV,
  GOVERNED_QUOTE_SEND_DIR_ENV,
  readGovernedQuoteSendEvidence,
  seedApprovedQuoteSend,
  type GovernedQuoteSendEvidence,
} from "../../src/preview/temporalPass/temporal/activities/governedQuoteSendFileGate.js";
import { passWorkflow } from "../../src/preview/temporalPass/temporal/workflows/passWorkflow.js";
import { ProcessHarness } from "./helpers/processHarness.js";

/**
 * Waits until the controlled provider has recorded exactly one accept and the
 * reconciliation envelope still has no receipt. That is the window after
 * `sendPrepared` and before the activity returns.
 */
async function waitForAcceptedWithoutReceipt(
  directory: string,
  timeoutMs = 20_000,
): Promise<GovernedQuoteSendEvidence> {
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    const evidence = await readGovernedQuoteSendEvidence(directory);
    if (evidence.sends > 0) return evidence;
    await sleep(25);
  }
  throw new Error("Timed out waiting for quotes:send to accept");
}

describe("governed quotes:send reconciles after a crash between provider accept and activity completion", () => {
  let harness: ProcessHarness;
  let client: Client;
  let quoteSendDir: string;
  let previousDir: string | undefined;
  let previousDelay: string | undefined;

  before(async () => {
    quoteSendDir = path.join(os.tmpdir(), `temporal-pass-quote-send-${randomUUID()}`);
    await seedApprovedQuoteSend(quoteSendDir);
    previousDir = process.env[GOVERNED_QUOTE_SEND_DIR_ENV];
    previousDelay = process.env[GOVERNED_QUOTE_SEND_ACCEPT_DELAY_ENV];
    process.env[GOVERNED_QUOTE_SEND_DIR_ENV] = quoteSendDir;
    process.env[GOVERNED_QUOTE_SEND_ACCEPT_DELAY_ENV] = "4000";

    harness = new ProcessHarness();
    await harness.startServer();
    await harness.startWorker();
    const connection = await Connection.connect({ address: harness.address });
    client = new Client({ connection, namespace: "default" });
  });

  after(async () => {
    await client?.connection.close();
    await harness?.teardown();
    if (previousDir === undefined) delete process.env[GOVERNED_QUOTE_SEND_DIR_ENV];
    else process.env[GOVERNED_QUOTE_SEND_DIR_ENV] = previousDir;
    if (previousDelay === undefined) delete process.env[GOVERNED_QUOTE_SEND_ACCEPT_DELAY_ENV];
    else process.env[GOVERNED_QUOTE_SEND_ACCEPT_DELAY_ENV] = previousDelay;
    if (quoteSendDir) await rm(quoteSendDir, { recursive: true, force: true });
  });

  it("retries once against the open reconciliation and does not send again", async () => {
    const missionId = `quote-send-crash-${randomUUID()}`;
    const repo = `repo-${missionId}`;

    const handle = await client.workflow.start(passWorkflow, {
      taskQueue: harness.taskQueue,
      workflowId: missionId,
      args: [
        {
          id: missionId,
          type: "SIMPLE_ACTION",
          description: "governed quote send crash recovery",
          context: {
            repo,
            governedQuoteSend: {
              projectId: "project-1",
              actionId: "action-send-1",
              authority: "T2",
            },
          },
        },
      ],
    });

    const interrupted = await waitForAcceptedWithoutReceipt(quoteSendDir);
    assert.equal(interrupted.sends, 1);
    assert.equal(interrupted.prepares, 1);
    assert.equal(interrupted.envelope?.receipt ?? null, null);

    harness.killWorker();
    await harness.startWorker();

    const result = await handle.result();
    assert.equal(result.status, "COMPLETED");
    assert.ok(result.completedSteps.includes("GOVERNED_QUOTE_SEND"));

    const evidence = await readGovernedQuoteSendEvidence(quoteSendDir);
    assert.equal(evidence.sends, 1, "provider accept count across crash and retry");
    assert.equal(evidence.prepares, 1);
    assert.equal(evidence.envelope?.receipt?.status, "indeterminate");
    assert.equal(evidence.envelope?.receipt?.errorCode, "retry-blocked-pending-reconciliation");

    const repoState = await new MockRepoStateStore(harness.mockRepoPath).get(repo);
    assert.equal(repoState.isMerged, true);
    assert.equal(repoState.mergeEffectCount, 1);
    assert.equal(repoState.mergeAttemptCount, 1);
  });
});
