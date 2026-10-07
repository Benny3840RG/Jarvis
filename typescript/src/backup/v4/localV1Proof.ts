import fs from "node:fs/promises";
import path from "node:path";

import { sha256Hex, sha256HexBytes } from "../../actions/sha256.js";
import { JARVIS_DATA_DIR } from "../../persistence/jarvisDataPaths.js";
import { assertRecoverable } from "../archiveManifest.js";
import type { ArchiveV4 } from "./archive.js";
import { S4_MAX_PAYLOAD_BYTES } from "./convexCapture.js";
import { LOCAL_V1_BLOB_DIR, LOCAL_V1_RECEIPTS_FILE, LOCAL_V1_S6_FILE } from "./localV1Capture.js";
import {
  LOCAL_V1_RECEIPT_CAPTURE_VERSION,
  LOCAL_V1_RECEIPT_ROW_CAP,
  LOCAL_V1_RECEIPT_TABLES,
} from "./localV1Receipts.js";
import {
  restoreLocalV1Archive,
  type LocalV1RestoreRequest,
  type LocalV1RestoreResult,
} from "./localV1Restore.js";
import { RESTORE_IN_PROGRESS_MARKER, RESTORE_MARKER } from "./restore.js";
import { S6_CAPTURE_VERSION, S6_TABLES } from "./s6MutableQuotes.js";

/** Same per-table bound the S6 capture already enforces. This gate does not raise it. */
const S6_ROW_CAP = 100;

export class LocalV1ProofError extends Error {
  constructor(message: string, options?: ErrorOptions) {
    super(message, options);
    this.name = "LocalV1ProofError";
  }
}

/** Ids a restarted isolated process must serve again. Empty is a failed proof. */
export type IsolatedRead = {
  clientId: string;
  taskId: string;
  buildId: string;
  quoteId: string;
};

export type LocalV1ProofRequest = {
  /** Existing isolated restore. This gate does not apply the archive itself. */
  restore: LocalV1RestoreRequest;
  /** Live data directory whose bytes must be unchanged by the proof. */
  liveDirectory: string;
  /** Second read of the isolated targets, including a restarted HTTP process. */
  readIsolated: () => Promise<IsolatedRead>;
};

function object(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isNodeError(error: unknown): error is NodeJS.ErrnoException {
  return error instanceof Error && "code" in error;
}

function assertRead(read: IsolatedRead): void {
  const ids = [read.clientId, read.taskId, read.buildId, read.quoteId];
  if (ids.some((id) => typeof id !== "string" || id.length === 0)) {
    throw new LocalV1ProofError("Local V1 proof read was empty.");
  }
}

/** Compare two isolated reads. A mismatch is a failed restart, not a second restore. */
export function assertIsolatedReadsMatch(first: IsolatedRead, second: IsolatedRead): void {
  assertRead(first);
  assertRead(second);
  if (
    first.clientId !== second.clientId ||
    first.taskId !== second.taskId ||
    first.buildId !== second.buildId ||
    first.quoteId !== second.quoteId
  ) {
    throw new LocalV1ProofError("Local V1 proof restart did not match the first read.");
  }
}

/** Byte digest of one directory. The proof uses this for the live data directory. */
export async function localV1LiveDirectoryDigest(root: string): Promise<string> {
  return directoryDigest(root);
}

async function directoryDigest(root: string): Promise<string> {
  const lines: string[] = [];
  async function walk(directory: string): Promise<void> {
    const names = await fs.readdir(directory).catch((error: unknown) => {
      if (isNodeError(error) && error.code === "ENOENT" && directory === path.resolve(root)) {
        return [];
      }
      throw error;
    });
    names.sort();
    for (const name of names) {
      const full = path.join(directory, name);
      const entry = await fs.lstat(full);
      const relative = path.relative(path.resolve(root), full);
      if (entry.isSymbolicLink()) {
        lines.push(`link ${relative}`);
        continue;
      }
      if (entry.isDirectory()) {
        lines.push(`dir ${relative}`);
        await walk(full);
        continue;
      }
      if (entry.isFile()) {
        const bytes = await fs.readFile(full);
        lines.push(`file ${relative} ${sha256HexBytes(bytes)} ${bytes.byteLength}`);
        continue;
      }
      lines.push(`other ${relative}`);
    }
  }
  await walk(path.resolve(root));
  return sha256Hex(lines.join("\n"));
}

function assertStores(archive: ArchiveV4): void {
  const business = archive.groups.businessRecords;
  const core = archive.groups.core;
  const memory = archive.groups.memory;
  const collections = [
    business?.clients,
    business?.properties,
    business?.projects,
    business?.quotes,
    business?.invoices,
    business?.enquiries,
    business?.errands,
    core?.tasks,
    core?.reminders,
    memory?.builds,
    memory?.buildLogs,
    memory?.upgrades,
    memory?.assets,
    memory?.preferences,
  ];
  if (
    !business ||
    !core ||
    !memory ||
    !("businessSettings" in business) ||
    (business.businessSettings !== null && !object(business.businessSettings)) ||
    !object(core.state) ||
    collections.some((value) => !Array.isArray(value))
  ) {
    throw new LocalV1ProofError("Local V1 proof capture omitted a required store.");
  }
}

async function capturedTables(
  filePath: string,
  version: string,
  tables: readonly string[],
  rowCap: number,
): Promise<unknown[]> {
  const raw = await fs.readFile(filePath, "utf8");
  if (new TextEncoder().encode(raw).length > S4_MAX_PAYLOAD_BYTES) {
    throw new LocalV1ProofError("Local V1 proof capture skipped or overflowed a table.");
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw) as unknown;
  } catch (error: unknown) {
    throw new LocalV1ProofError("Local V1 proof capture omitted a required table.", {
      cause: error,
    });
  }
  if (!object(parsed) || typeof parsed.payloadJson !== "string") {
    throw new LocalV1ProofError("Local V1 proof capture omitted a required table.");
  }
  if (new TextEncoder().encode(parsed.payloadJson).length > S4_MAX_PAYLOAD_BYTES) {
    throw new LocalV1ProofError("Local V1 proof capture skipped or overflowed a table.");
  }
  if (
    typeof parsed.payloadSha256 !== "string" ||
    sha256HexBytes(new TextEncoder().encode(parsed.payloadJson)) !== parsed.payloadSha256
  ) {
    throw new LocalV1ProofError("Local V1 proof capture omitted a required table.");
  }
  let payload: unknown;
  try {
    payload = JSON.parse(parsed.payloadJson) as unknown;
  } catch (error: unknown) {
    throw new LocalV1ProofError("Local V1 proof capture omitted a required table.", {
      cause: error,
    });
  }
  if (
    !object(payload) ||
    payload.version !== version ||
    "skipped" in payload ||
    "truncated" in payload ||
    !Array.isArray(payload.tables) ||
    payload.tables.length !== tables.length
  ) {
    throw new LocalV1ProofError("Local V1 proof capture omitted a required table.");
  }
  for (let index = 0; index < tables.length; index += 1) {
    const entry = payload.tables[index];
    if (!object(entry) || entry.table !== tables[index] || !Array.isArray(entry.documents)) {
      throw new LocalV1ProofError(
        `Local V1 proof capture omitted required table ${tables[index] ?? ""}.`,
      );
    }
    const keys = Object.keys(entry).sort();
    if (
      keys.length !== 2 ||
      keys[0] !== "documents" ||
      keys[1] !== "table" ||
      entry.documents.length > rowCap
    ) {
      throw new LocalV1ProofError("Local V1 proof capture skipped or overflowed a table.");
    }
  }
  return payload.tables;
}

async function assertBlobs(
  captureDirectory: string,
  archive: ArchiveV4,
  s6Tables: unknown[],
): Promise<void> {
  const artifacts = s6Tables[S6_TABLES.indexOf("quotePdfArtifacts")];
  if (!object(artifacts) || !Array.isArray(artifacts.documents)) {
    throw new LocalV1ProofError("PDF bytes are missing for a captured artifact.");
  }
  if (artifacts.documents.length !== archive.manifest.blobs.length) {
    throw new LocalV1ProofError("PDF bytes are missing for a captured artifact.");
  }
  const blobDir = path.join(captureDirectory, LOCAL_V1_BLOB_DIR);
  for (const artifact of artifacts.documents) {
    if (
      !object(artifact) ||
      typeof artifact._id !== "string" ||
      typeof artifact.digest !== "string"
    ) {
      throw new LocalV1ProofError("PDF bytes are missing for a captured artifact.");
    }
    const reference = `quotePdfArtifacts/${artifact._id}`;
    const listed = archive.manifest.blobs.find((blob) => blob.reference === reference);
    const hex = artifact.digest.startsWith("quote-pdf:v1:sha256:")
      ? artifact.digest.slice("quote-pdf:v1:sha256:".length)
      : "";
    if (!listed || listed.digest !== `sha256:${hex}` || !/^[a-f0-9]{64}$/.test(hex)) {
      throw new LocalV1ProofError(`PDF bytes are missing for ${reference}.`);
    }
    const filePath = path.join(blobDir, hex);
    const entry = await fs.lstat(filePath).catch((error: unknown) => {
      if (isNodeError(error) && error.code === "ENOENT") {
        throw new LocalV1ProofError(`PDF bytes are missing for ${reference}.`);
      }
      throw error;
    });
    if (entry.isSymbolicLink() || !entry.isFile()) {
      throw new LocalV1ProofError(`PDF bytes are missing for ${reference}.`);
    }
    const bytes = await fs.readFile(filePath);
    if (sha256HexBytes(bytes) !== hex || bytes.byteLength !== listed.byteLength) {
      throw new LocalV1ProofError("PDF digest does not match stored bytes.");
    }
  }
}

async function assertJsonRestore(jsonDirectory: string, archive: ArchiveV4): Promise<void> {
  const markerPath = path.join(jsonDirectory, RESTORE_MARKER);
  const entry = await fs.lstat(markerPath).catch((error: unknown) => {
    if (isNodeError(error) && error.code === "ENOENT") return null;
    throw error;
  });
  if (entry === null || entry.isSymbolicLink() || !entry.isFile()) {
    throw new LocalV1ProofError("Local V1 proof did not finish the isolated JSON restore.");
  }
  const marker = JSON.parse(await fs.readFile(markerPath, "utf8")) as unknown;
  if (
    !object(marker) ||
    marker.completeness !== "partial" ||
    archive.manifest.completeness !== "partial"
  ) {
    throw new LocalV1ProofError("Local V1 proof refuses to mark a partial capture complete.");
  }
  const inProgress = await fs
    .lstat(path.join(jsonDirectory, RESTORE_IN_PROGRESS_MARKER))
    .catch((error: unknown) => {
      if (isNodeError(error) && error.code === "ENOENT") return null;
      throw error;
    });
  if (inProgress !== null) {
    throw new LocalV1ProofError("Local V1 proof left an in-progress restore.");
  }
  try {
    assertRecoverable(archive.manifest);
  } catch (error: unknown) {
    if (error instanceof LocalV1ProofError) throw error;
    return;
  }
  throw new LocalV1ProofError(
    "Local V1 proof refuses to treat a partial capture as full recovery.",
  );
}

/**
 * Proves one partial Local V1 capture on isolated targets.
 * Calls `restoreLocalV1Archive` and does not write the live provider.
 * `completeness` stays partial.
 */
function assertSameLiveDirectory(request: LocalV1ProofRequest): void {
  const proofLive = path.resolve(request.liveDirectory);
  const restoreLive = path.resolve(request.restore.liveDataDir ?? JARVIS_DATA_DIR);
  if (proofLive !== restoreLive) {
    throw new LocalV1ProofError(
      "Local V1 proof requires liveDirectory to be the restore live data directory.",
    );
  }
}

export async function proveLocalV1Recovery(
  request: LocalV1ProofRequest,
): Promise<LocalV1RestoreResult> {
  assertSameLiveDirectory(request);
  if (typeof request.readIsolated !== "function") {
    throw new LocalV1ProofError("Local V1 proof requires an isolated read.");
  }
  const before = await directoryDigest(request.liveDirectory);
  let restored: LocalV1RestoreResult;
  try {
    restored = await restoreLocalV1Archive(request.restore);
  } catch (error: unknown) {
    const after = await directoryDigest(request.liveDirectory);
    if (after !== before) {
      throw new LocalV1ProofError("Local V1 proof changed the live data directory.", {
        cause: error,
      });
    }
    throw error;
  }
  try {
    const capture = path.resolve(request.restore.captureDirectory);
    assertStores(restored.archive);
    await assertJsonRestore(restored.jsonDirectory, restored.archive);
    const s6Tables = await capturedTables(
      path.join(capture, LOCAL_V1_S6_FILE),
      S6_CAPTURE_VERSION,
      S6_TABLES,
      S6_ROW_CAP,
    );
    await capturedTables(
      path.join(capture, LOCAL_V1_RECEIPTS_FILE),
      LOCAL_V1_RECEIPT_CAPTURE_VERSION,
      LOCAL_V1_RECEIPT_TABLES,
      LOCAL_V1_RECEIPT_ROW_CAP,
    );
    await assertBlobs(capture, restored.archive, s6Tables);
    if ((await directoryDigest(request.liveDirectory)) !== before) {
      throw new LocalV1ProofError("Local V1 proof changed the live data directory.");
    }
    if (restored.archive.manifest.completeness !== "partial") {
      throw new LocalV1ProofError("Local V1 proof refuses to mark a partial capture complete.");
    }
    const first = await request.readIsolated();
    const second = await request.readIsolated();
    assertIsolatedReadsMatch(first, second);
    return restored;
  } catch (error: unknown) {
    const after = await directoryDigest(request.liveDirectory);
    if (after !== before) {
      throw new LocalV1ProofError("Local V1 proof changed the live data directory.", {
        cause: error,
      });
    }
    throw error;
  }
}
