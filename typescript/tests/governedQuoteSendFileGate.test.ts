import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, it } from "node:test";

import { PolicyEngineNotAuthorityError } from "../src/actions/governedExternalOperation.js";
import {
  GovernedQuoteSendUnavailableError,
  executeGovernedQuoteSend,
  loadGovernedQuoteSendGateFromEnv,
  type GovernedQuoteSendGate,
} from "../src/preview/temporalPass/temporal/activities/governedQuoteSend.js";
import {
  GOVERNED_QUOTE_SEND_DIR_ENV,
  readGovernedQuoteSendEvidence,
  seedApprovedQuoteSend,
  loadFileBackedGovernedQuoteSendGate,
} from "../src/preview/temporalPass/temporal/activities/governedQuoteSendFileGate.js";

const directories: string[] = [];

async function seededGate(): Promise<{ directory: string; gate: GovernedQuoteSendGate }> {
  const directory = await mkdtemp(path.join(os.tmpdir(), "governed-quote-send-"));
  directories.push(directory);
  await seedApprovedQuoteSend(directory);
  return { directory, gate: loadFileBackedGovernedQuoteSendGate(directory) };
}

afterEach(async () => {
  await Promise.all(directories.splice(0).map((directory) => rm(directory, { recursive: true })));
});

describe("file-backed governed quotes:send", () => {
  it("observes the indeterminate receipt on a second execute and does not send again", async () => {
    const { directory, gate } = await seededGate();
    const input = {
      mode: "execute" as const,
      projectId: "project-1",
      actionId: "action-send-1",
      authority: "T2" as const,
    };
    const first = await executeGovernedQuoteSend(input, () => gate);
    const second = await executeGovernedQuoteSend(input, () => gate);
    const evidence = await readGovernedQuoteSendEvidence(directory);

    assert.equal(first.status, "indeterminate");
    assert.equal(second.status, "indeterminate");
    assert.equal(second.receiptId, first.receiptId);
    assert.equal(second.reconciliationId, first.reconciliationId);
    assert.equal(evidence.prepares, 1);
    assert.equal(evidence.sends, 1);
    assert.equal(evidence.envelope?.receipt?.status, "indeterminate");
    assert.equal(evidence.envelope?.receipt?.receiptId, first.receiptId);
  });

  it("rejects a PolicyEngine allow decision before the file-backed provider is called", async () => {
    const { directory, gate } = await seededGate();
    await assert.rejects(
      () =>
        executeGovernedQuoteSend(
          {
            mode: "execute",
            projectId: "project-1",
            actionId: "action-send-1",
            authority: "T2",
            authorityDecision: { allowed: true, reason: "PolicyEngine allow" },
          },
          () => gate,
        ),
      PolicyEngineNotAuthorityError,
    );
    const evidence = await readGovernedQuoteSendEvidence(directory);
    assert.equal(evidence.prepares, 0);
    assert.equal(evidence.sends, 0);
    assert.equal(evidence.envelope, null);
  });

  it("refuses when the test-only durable directory is unset", async () => {
    const previous = process.env[GOVERNED_QUOTE_SEND_DIR_ENV];
    delete process.env[GOVERNED_QUOTE_SEND_DIR_ENV];
    try {
      assert.equal(loadGovernedQuoteSendGateFromEnv(), null);
      await assert.rejects(
        () =>
          executeGovernedQuoteSend({
            mode: "execute",
            projectId: "project-1",
            actionId: "action-send-1",
            authority: "T2",
          }),
        GovernedQuoteSendUnavailableError,
      );
    } finally {
      if (previous === undefined) delete process.env[GOVERNED_QUOTE_SEND_DIR_ENV];
      else process.env[GOVERNED_QUOTE_SEND_DIR_ENV] = previous;
    }
  });
});
