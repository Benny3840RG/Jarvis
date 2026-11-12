import { constants } from "node:fs";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import { sha256HexBytes } from "../../actions/sha256.js";
import { assertLedgerIntact } from "../../ownerGate/ownerDecision.js";
import { JsonLinesOwnerDecisionLedger } from "../../ownerGate/ownerDecisionService.js";
import type { LocalV1OwnerDecisionLedger } from "../archiveManifest.js";

export const LOCAL_V1_LEDGER_FILE = "jarvis-owner-decisions.jsonl";
export const LOCAL_V1_CHECKPOINT_FILE = `${LOCAL_V1_LEDGER_FILE}.checkpoint.json`;

function missing(error: unknown): boolean {
  return error instanceof Error && "code" in error && error.code === "ENOENT";
}

async function readPrivate(filePath: string): Promise<Buffer | null> {
  let handle: fs.FileHandle;
  try {
    handle = await fs.open(filePath, constants.O_RDONLY | constants.O_NOFOLLOW);
  } catch (error: unknown) {
    if (missing(error)) return null;
    throw new Error(
      `Owner decision ledger file could not be opened safely: ${path.basename(filePath)}.`,
      { cause: error },
    );
  }
  try {
    const stat = await handle.stat();
    if (!stat.isFile() || (stat.mode & 0o777) !== 0o600) {
      throw new Error(
        `Owner decision ledger file must be an owner-only regular file (mode 0600): ${path.basename(filePath)}.`,
      );
    }
    return await handle.readFile();
  } finally {
    await handle.close();
  }
}

async function writeExclusive(filePath: string, bytes: Buffer): Promise<void> {
  const handle = await fs.open(
    filePath,
    constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW,
    0o600,
  );
  try {
    await handle.writeFile(bytes);
    await handle.sync();
  } finally {
    await handle.close();
  }
}

/** Verify exact captured bytes through the canonical owner ledger reader and chain checker. */
async function validate(ledger: Buffer, checkpoint: Buffer): Promise<number> {
  const temp = await fs.mkdtemp(path.join(os.tmpdir(), "jarvis-lv1-ledger-verify-"));
  try {
    const file = path.join(temp, LOCAL_V1_LEDGER_FILE);
    await writeExclusive(file, ledger);
    await writeExclusive(`${file}.checkpoint.json`, checkpoint);
    const records = await new JsonLinesOwnerDecisionLedger(file).read();
    assertLedgerIntact(records);
    return records.length;
  } finally {
    await fs.rm(temp, { recursive: true, force: true });
  }
}

async function readPair(directory: string): Promise<{ ledger: Buffer; checkpoint: Buffer } | null> {
  const [ledger, checkpoint] = await Promise.all([
    readPrivate(path.join(directory, LOCAL_V1_LEDGER_FILE)),
    readPrivate(path.join(directory, LOCAL_V1_CHECKPOINT_FILE)),
  ]);
  if (ledger === null && checkpoint === null) return null;
  if (ledger === null || checkpoint === null) {
    throw new Error("Owner decision ledger and checkpoint must both be present.");
  }
  return { ledger, checkpoint };
}

/** Reads source files only; rejects any incomplete or damaged ledger before writing sidecars. */
export async function captureLocalV1Ledger(
  sourceDirectory: string,
  captureDirectory: string,
): Promise<LocalV1OwnerDecisionLedger> {
  const pair = await readPair(sourceDirectory);
  if (pair === null) return { state: "absent" };
  const recordCount = await validate(pair.ledger, pair.checkpoint);
  const state: LocalV1OwnerDecisionLedger = {
    state: "present",
    ledgerSha256: `sha256:${sha256HexBytes(pair.ledger)}`,
    checkpointSha256: `sha256:${sha256HexBytes(pair.checkpoint)}`,
    recordCount,
  };
  await writeExclusive(path.join(captureDirectory, LOCAL_V1_LEDGER_FILE), pair.ledger);
  await writeExclusive(path.join(captureDirectory, LOCAL_V1_CHECKPOINT_FILE), pair.checkpoint);
  return state;
}

/** Re-checks archive bytes and the canonical ledger invariants. */
export async function verifyLocalV1Ledger(
  captureDirectory: string,
  state: LocalV1OwnerDecisionLedger | undefined,
): Promise<"not-captured" | "absent" | "present"> {
  if (state === undefined) return "not-captured";
  const pair = await readPair(captureDirectory);
  if (state.state === "absent") {
    if (pair !== null)
      throw new Error("An absent owner decision ledger has unexpected captured files.");
    return "absent";
  }
  if (pair === null) throw new Error("Captured owner decision ledger and checkpoint are missing.");
  if (
    `sha256:${sha256HexBytes(pair.ledger)}` !== state.ledgerSha256 ||
    `sha256:${sha256HexBytes(pair.checkpoint)}` !== state.checkpointSha256
  ) {
    throw new Error(
      "Captured owner decision ledger or checkpoint digest does not match the archive manifest.",
    );
  }
  const count = await validate(pair.ledger, pair.checkpoint);
  if (count !== state.recordCount)
    throw new Error(
      "Captured owner decision ledger record count does not match the archive manifest.",
    );
  return "present";
}

/** Writes checkpoint first: interruption can leave only a damaged checkpoint, never a valid shorter history. */
export async function restoreLocalV1Ledger(
  captureDirectory: string,
  targetDirectory: string,
  state: LocalV1OwnerDecisionLedger | undefined,
): Promise<"not-captured" | "absent" | "present"> {
  const status = await verifyLocalV1Ledger(captureDirectory, state);
  const ledgerPath = path.join(targetDirectory, LOCAL_V1_LEDGER_FILE);
  const checkpointPath = path.join(targetDirectory, LOCAL_V1_CHECKPOINT_FILE);
  for (const file of [ledgerPath, checkpointPath]) {
    if (
      await fs.lstat(file).then(
        () => true,
        (error: unknown) => {
          if (missing(error)) return false;
          throw error;
        },
      )
    )
      throw new Error(`Target owner decision ledger file already exists: ${path.basename(file)}.`);
  }
  if (status !== "present") return status;
  const pair = await readPair(captureDirectory);
  if (pair === null) throw new Error("Captured owner decision ledger is missing.");
  await writeExclusive(checkpointPath, pair.checkpoint);
  await writeExclusive(ledgerPath, pair.ledger);
  return "present";
}
