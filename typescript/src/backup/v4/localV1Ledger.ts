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

export async function readLocalV1LedgerFileNoFollow(filePath: string): Promise<Buffer | null> {
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
    await handle.chmod(0o600);
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
    await fs.chmod(temp, 0o700);
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
  // The writer appends the ledger before updating its checkpoint, so read the checkpoint first.
  const checkpoint = await readLocalV1LedgerFileNoFollow(
    path.join(directory, LOCAL_V1_CHECKPOINT_FILE),
  );
  const ledger = await readLocalV1LedgerFileNoFollow(path.join(directory, LOCAL_V1_LEDGER_FILE));
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
  const source = await fs.stat(sourceDirectory).catch((error: unknown) => {
    throw new Error("Owner decision ledger source directory does not exist or is unreadable.", {
      cause: error,
    });
  });
  if (!source.isDirectory())
    throw new Error("Owner decision ledger source directory is not a directory.");
  let pair = await readPair(sourceDirectory);
  // A writer can advance between the checkpoint and ledger reads. Retry only
  // when the bytes moved; a stable damaged pair remains a hard refusal.
  for (let attempt = 0; attempt < 3 && pair !== null; attempt += 1) {
    try {
      await validate(pair.ledger, pair.checkpoint);
      break;
    } catch (error: unknown) {
      const next = await readPair(sourceDirectory);
      if (
        next === null ||
        (pair.ledger.equals(next.ledger) && pair.checkpoint.equals(next.checkpoint)) ||
        attempt === 2
      )
        throw error;
      pair = next;
    }
  }
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
export async function readVerifiedLocalV1Ledger(
  captureDirectory: string,
  state: LocalV1OwnerDecisionLedger | undefined,
): Promise<
  | { status: "not-captured" | "absent"; pair: null }
  | { status: "present"; pair: { ledger: Buffer; checkpoint: Buffer } }
> {
  if (state === undefined) return { status: "not-captured", pair: null };
  const pair = await readPair(captureDirectory);
  if (state.state === "absent") {
    if (pair !== null)
      throw new Error("An absent owner decision ledger has unexpected captured files.");
    return { status: "absent", pair: null };
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
  return { status: "present", pair };
}

export async function verifyLocalV1Ledger(
  captureDirectory: string,
  state: LocalV1OwnerDecisionLedger | undefined,
): Promise<"not-captured" | "absent" | "present"> {
  return (await readVerifiedLocalV1Ledger(captureDirectory, state)).status;
}
