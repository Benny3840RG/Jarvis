import assert from "node:assert/strict";
import { test } from "node:test";

import {
  localV1RestartProofPassed,
  renderLocalV1RestartProofEvidence,
  type LocalV1RestartProofRecord,
} from "../src/backup/v4/localV1RecoveryDriver.js";

const passing: LocalV1RestartProofRecord = {
  sourceSha: "0123456789abcdef0123456789abcdef01234567",
  isolatedEndpoint: "127.0.0.1:3210",
  configuredUrlRefused: true,
  quoteRecovered: true,
  quoteBodySha256: "a".repeat(64),
  clientMatched: true,
  taskMatched: true,
  buildMatched: true,
  liveDirectoryUnchanged: true,
};

test("a failed configured-URL refusal cannot pass the restart proof", () => {
  const record = { ...passing, configuredUrlRefused: false };
  assert.match(renderLocalV1RestartProofEvidence(record), /refused as target \| FAIL/);
  assert.equal(localV1RestartProofPassed(record), false);
});

test("every mandatory recorded failure rejects the restart proof", () => {
  for (const field of [
    "quoteRecovered",
    "clientMatched",
    "taskMatched",
    "buildMatched",
    "liveDirectoryUnchanged",
  ] as const) {
    assert.equal(localV1RestartProofPassed({ ...passing, [field]: false }), false, field);
  }
  assert.equal(localV1RestartProofPassed(passing), true);
});

test("an absent optional configured URL is explicitly not applicable", () => {
  const record = { ...passing, configuredUrlRefused: null };
  assert.match(renderLocalV1RestartProofEvidence(record), /refused as target \| N\/A/);
  assert.equal(localV1RestartProofPassed(record), true);
  assert.doesNotMatch(renderLocalV1RestartProofEvidence(record), /\| FAIL/);
});

test("driver records absent configured URL as N/A without claiming a refusal", async () => {
  const fs = await import("node:fs/promises");
  const os = await import("node:os");
  const path = await import("node:path");
  const { runLocalV1RestartProof } = await import("../src/backup/v4/localV1RecoveryDriver.js");
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "lv1-proof-record-"));
  try {
    const body = {
      clientBody: "client",
      taskBody: "task",
      buildBody: "build",
      quoteStatus: 200,
      quoteBody: "quote",
    };
    let calls = 0;
    const record = await runLocalV1RestartProof(
      {
        isolatedConvexUrl: "http://127.0.0.1:3210",
        configuredConvexUrl: undefined,
        deliveryRuntimeToken: "fixture-only",
        jsonDirectory: path.join(root, "isolated"),
        liveDirectory: root,
        ids: { clientId: "client", taskId: "task", buildId: "build", quoteId: "quote" },
        sourceSha: passing.sourceSha,
      },
      {
        restartRunner: async () => {
          calls += 1;
          return { first: body, second: body, quoteRecovered: true };
        },
      },
    );
    assert.equal(calls, 1);
    assert.equal(record.configuredUrlRefused, null);
    assert.equal(localV1RestartProofPassed(record), true);
  } finally {
    await fs.rm(root, { recursive: true, force: true });
  }
});
