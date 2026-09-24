import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { after, before, describe, it } from "node:test";
import { setTimeout as sleep } from "node:timers/promises";

import { Client, Connection } from "@temporalio/client";

import { passWorkflow } from "../../src/preview/temporalPass/temporal/workflows/passWorkflow.js";
import { MockRepoStateStore } from "../../src/preview/temporalPass/temporal/activities/mockRepoState.js";
import { ProcessHarness } from "./helpers/processHarness.js";

/**
 * Polls the mock repo state directly rather than sleeping a fixed duration.
 * This test needs the kill to land specifically *after* mergePR's mutation
 * (isMerged flips to true) but before it returns — a fixed sleep is a guess
 * at that window, while `isMerged` becoming true is the actual event being
 * waited for, observable through the same file the Activity itself writes.
 */
async function waitForRepoMerged(
  repoStore: MockRepoStateStore,
  repo: string,
  timeoutMs = 5_000,
): Promise<void> {
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    const state = await repoStore.get(repo);
    if (state.isMerged) return;
    await sleep(25);
  }
  throw new Error(`Timed out waiting for repo "${repo}" to report isMerged`);
}

// PASS-13: the nastiest Temporal window — the mock "GitHub" accepts the
// merge (the mock repo's `isMerged`/`mergedSha` are already updated), and
// only *then* does the worker get killed, before Temporal durably records
// the Activity's completion. `scenario.mergeDelayMs` holds `mergePR` open
// (heartbeating) in exactly that post-mutation, pre-return window. On
// retry, the new worker must reconcile against the already-merged mock
// repo state rather than erroring or merging a second time.
describe("PASS-13 reconciles after a crash between the external effect and Activity completion", () => {
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

  it("reconciles the already-merged state instead of duplicating or failing the retry", async () => {
    const missionId = `merge-crash-${randomUUID()}`;
    const repo = `repo-${missionId}`;

    const handle = await client.workflow.start(passWorkflow, {
      taskQueue: harness.taskQueue,
      workflowId: missionId,
      args: [
        {
          id: missionId,
          type: "SIMPLE_ACTION",
          description: "merge crash recovery test",
          context: { repo },
          scenario: { mergeDelayMs: 4_000 },
        },
      ],
    });

    const repoStore = new MockRepoStateStore(harness.mockRepoPath);
    await waitForRepoMerged(repoStore, repo);
    harness.killWorker();
    await harness.startWorker();

    const result = await handle.result();
    assert.equal(result.status, "COMPLETED");

    const { IdempotencyStore } =
      await import("../../src/preview/temporalPass/idempotency/idempotencyStore.js");
    const idempotencyStore = new IdempotencyStore(harness.idempotencyPath);

    const mergeEntry = await idempotencyStore.get(`${missionId}:merge:mergePR:v1`);
    assert.equal(mergeEntry?.state, "completed");

    const repoState = await repoStore.get(repo);
    assert.equal(repoState.isMerged, true);
    const buildEntry = await idempotencyStore.get(`${missionId}:build:executeBuild:v1`);
    const builtSha = (buildEntry?.result as { commitSha: string }).commitSha;
    assert.equal(repoState.mergedSha, builtSha);

    // The real assertion: two Activity *attempts* happened (the interrupted
    // one that got SIGKILLed mid-heartbeat, and the retry that reconciled
    // against it), but the external effect only happened once. Comparing
    // final state alone (mergedSha === builtSha, above) can't distinguish
    // "merged once" from "merged twice with an idempotent identical
    // result" — a second, uncoordinated merge landing on the same SHA would
    // pass that comparison too. These counters can't.
    assert.equal(repoState.mergeAttemptCount, 2, "expected the interrupted attempt plus one retry");
    assert.equal(repoState.mergeEffectCount, 1, "expected the external merge effect exactly once");
  });
});
