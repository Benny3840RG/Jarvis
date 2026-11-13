import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, it, mock } from "node:test";

import {
  LEDGER_GENESIS_HASH,
  ownerDecisionRecordHash,
  type OwnerDecisionRecord,
} from "../src/ownerGate/ownerDecision.js";
import { sha256HexBytes } from "../src/actions/sha256.js";
import { JsonLinesOwnerDecisionLedger } from "../src/ownerGate/ownerDecisionService.js";
import {
  captureLocalV1Ledger,
  verifyLocalV1Ledger,
  restoreLocalV1Ledger,
  LOCAL_V1_LEDGER_FILE,
  LOCAL_V1_CHECKPOINT_FILE,
} from "../src/backup/v4/localV1Ledger.js";

const dirs: string[] = [];
async function scratch(): Promise<string> {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "jarvis-lv1-ledger-"));
  dirs.push(dir);
  return dir;
}
afterEach(async () => {
  await Promise.all(dirs.splice(0).map((dir) => fs.rm(dir, { recursive: true, force: true })));
});

it("captures absent explicitly and restores no ledger", async () => {
  const root = await scratch();
  const source = path.join(root, "source");
  const capture = path.join(root, "capture");
  const target = path.join(root, "target");
  await Promise.all([fs.mkdir(source), fs.mkdir(capture), fs.mkdir(target)]);
  const state = await captureLocalV1Ledger(source, capture);
  assert.deepEqual(state, { state: "absent" });
  assert.equal(await verifyLocalV1Ledger(capture, state), "absent");
  assert.equal(await restoreLocalV1Ledger(capture, target, state), "absent");
  await assert.rejects(
    () => new JsonLinesOwnerDecisionLedger(path.join(target, LOCAL_V1_LEDGER_FILE)).read(),
    /No decision ledger/,
  );
});

it("reads the checkpoint before the ledger during capture", async () => {
  const root = await scratch();
  const source = path.join(root, "source");
  const capture = path.join(root, "capture");
  await Promise.all([fs.mkdir(source), fs.mkdir(capture)]);
  await new JsonLinesOwnerDecisionLedger(path.join(source, LOCAL_V1_LEDGER_FILE)).start();
  const opened: string[] = [];
  const originalOpen = fs.open.bind(fs);
  mock.method(fs, "open", async (...args: Parameters<typeof fs.open>) => {
    const file = String(args[0]);
    if (path.dirname(file) === source) opened.push(path.basename(file));
    return originalOpen(...args);
  });
  try {
    await captureLocalV1Ledger(source, capture);
  } finally {
    mock.restoreAll();
  }
  assert.deepEqual(opened.slice(0, 2), [LOCAL_V1_CHECKPOINT_FILE, LOCAL_V1_LEDGER_FILE]);
});

it("preserves exact bytes and checks digest, chain, checkpoint, and count", async () => {
  const root = await scratch();
  const source = path.join(root, "source");
  const capture = path.join(root, "capture");
  const target = path.join(root, "target");
  await Promise.all([fs.mkdir(source), fs.mkdir(capture), fs.mkdir(target)]);
  const ledgerPath = path.join(source, LOCAL_V1_LEDGER_FILE);
  await new JsonLinesOwnerDecisionLedger(ledgerPath).start();
  const before = await fs.readFile(ledgerPath);
  const checkpointBefore = await fs.readFile(`${ledgerPath}.checkpoint.json`);
  const state = await captureLocalV1Ledger(source, capture);
  assert.equal(state.state, "present");
  assert.equal(await verifyLocalV1Ledger(capture, state), "present");
  assert.equal(await restoreLocalV1Ledger(capture, target, state), "present");
  assert.deepEqual(await fs.readFile(path.join(target, LOCAL_V1_LEDGER_FILE)), before);
  assert.deepEqual(
    await fs.readFile(path.join(target, LOCAL_V1_CHECKPOINT_FILE)),
    checkpointBefore,
  );
  assert.equal((await fs.stat(path.join(target, LOCAL_V1_LEDGER_FILE))).mode & 0o777, 0o600);
  await assert.rejects(() => restoreLocalV1Ledger(capture, target, state), /already exists/);
  await fs.writeFile(
    path.join(capture, LOCAL_V1_CHECKPOINT_FILE),
    `${JSON.stringify({ count: 1, hash: LEDGER_GENESIS_HASH })}\n`,
  );
  await assert.rejects(() => verifyLocalV1Ledger(capture, state), /checkpoint|digest|count/);
});

it("a checkpoint written before a ledger is an unusable interrupted restore", async () => {
  const root = await scratch();
  const target = path.join(root, "target");
  await fs.mkdir(target);
  await fs.writeFile(
    path.join(target, LOCAL_V1_CHECKPOINT_FILE),
    `${JSON.stringify({ count: 0, hash: LEDGER_GENESIS_HASH })}\n`,
    { mode: 0o600 },
  );
  await assert.rejects(
    () => new JsonLinesOwnerDecisionLedger(path.join(target, LOCAL_V1_LEDGER_FILE)).read(),
    /not both present/,
  );
});

it("rejects modified, truncated and reordered captured records even with a recomputed digest", async () => {
  const root = await scratch();
  const source = path.join(root, "source");
  const capture = path.join(root, "capture");
  await Promise.all([fs.mkdir(source), fs.mkdir(capture)]);
  const ledger = new JsonLinesOwnerDecisionLedger(path.join(source, LOCAL_V1_LEDGER_FILE));
  await ledger.start();
  let previousHash = LEDGER_GENESIS_HASH;
  for (let sequence = 1; sequence <= 2; sequence += 1) {
    const body = {
      sequence,
      recordId: `record-${sequence}`,
      kind: "decision" as const,
      decisionId: `decision-${sequence}`,
      actionDigest: "a".repeat(64),
      subjects: [],
      environment: "development" as const,
      decision: "reject" as const,
      actor: "fixture-owner",
      idempotencyKey: `key-${sequence}`,
      requestDigest: "b".repeat(64),
      recordedAt: "2026-10-07T03:00:00.000Z",
      previousHash,
    };
    const record: OwnerDecisionRecord = { ...body, hash: ownerDecisionRecordHash(body) };
    await ledger.append(record);
    previousHash = record.hash;
  }
  const state = await captureLocalV1Ledger(source, capture);
  assert.equal(state.state, "present");
  const file = path.join(capture, LOCAL_V1_LEDGER_FILE);
  const original = await fs.readFile(file);
  const lines = original.toString("utf8").trimEnd().split("\n");
  for (const bytes of [
    Buffer.from(original.toString("utf8").replace("fixture-owner", "altered-owner")),
    original.subarray(0, original.length - 1),
    Buffer.from(`${lines.reverse().join("\n")}\n`),
  ]) {
    await fs.writeFile(file, bytes);
    await assert.rejects(() => verifyLocalV1Ledger(capture, state), /digest/);
  }
  const reordered = await fs.readFile(file);
  await assert.rejects(
    () =>
      verifyLocalV1Ledger(capture, {
        ...state,
        ledgerSha256: `sha256:${sha256HexBytes(reordered)}`,
      }),
    /intact|checkpoint/,
  );
  await fs.writeFile(file, original);
  await assert.rejects(() => verifyLocalV1Ledger(capture, { ...state, recordCount: 1 }), /count/);
});

it("refuses an incomplete source and symlinks without changing source", async () => {
  const root = await scratch();
  const source = path.join(root, "source");
  const capture = path.join(root, "capture");
  await Promise.all([fs.mkdir(source), fs.mkdir(capture)]);
  const ledgerPath = path.join(source, LOCAL_V1_LEDGER_FILE);
  await fs.writeFile(ledgerPath, "truncated", { mode: 0o600 });
  await fs.writeFile(
    `${ledgerPath}.checkpoint.json`,
    `${JSON.stringify({ count: 0, hash: LEDGER_GENESIS_HASH })}\n`,
    { mode: 0o600 },
  );
  await assert.rejects(() => captureLocalV1Ledger(source, capture), /ledger|record/);
  assert.equal(await fs.readFile(ledgerPath, "utf8"), "truncated");
  await fs.rm(ledgerPath);
  await fs.symlink(path.join(source, LOCAL_V1_CHECKPOINT_FILE), ledgerPath);
  await assert.rejects(() => captureLocalV1Ledger(source, capture), /ledger|safely/);
  await fs.rm(ledgerPath);
  await fs.mkdir(ledgerPath);
  await assert.rejects(() => captureLocalV1Ledger(source, capture), /regular file/);
  await fs.rm(ledgerPath, { recursive: true });
  await fs.writeFile(
    ledgerPath,
    `${JSON.stringify({ sequence: 1, previousHash: LEDGER_GENESIS_HASH, hash: "f".repeat(64) })}\n`,
    { mode: 0o600 },
  );
  await fs.writeFile(
    `${ledgerPath}.checkpoint.json`,
    `${JSON.stringify({ count: 1, hash: "f".repeat(64) })}\n`,
  );
  await assert.rejects(() => captureLocalV1Ledger(source, capture), /not intact/);
});

it("refuses a target with either ledger file and never writes the other", async () => {
  const root = await scratch();
  const source = path.join(root, "source");
  const capture = path.join(root, "capture");
  const target = path.join(root, "target");
  await Promise.all([fs.mkdir(source), fs.mkdir(capture), fs.mkdir(target)]);
  const state = await captureLocalV1Ledger(source, capture);
  await fs.writeFile(path.join(target, LOCAL_V1_CHECKPOINT_FILE), "existing", { mode: 0o600 });
  await assert.rejects(() => restoreLocalV1Ledger(capture, target, state), /already exists/);
  await assert.rejects(() => fs.stat(path.join(target, LOCAL_V1_LEDGER_FILE)), /ENOENT/);
});
