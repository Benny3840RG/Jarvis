import { createHash } from "node:crypto";
import fs from "node:fs/promises";
import path from "node:path";

import { makeFunctionReference, type FunctionReference } from "convex/server";

import { sha256HexBytes } from "../../actions/sha256.js";
import { exportBackup, type BackupArchive } from "../backup.js";
import { StrictBackupError } from "../strictValues.js";
import { ConvexAssetStore } from "../../assets/convexAssetStore.js";
import { ConvexBuildLogStore } from "../../buildLog/convexBuildLogStore.js";
import { ConvexBuildStore } from "../../builds/convexBuildStore.js";
import { ConvexPersistence, type ConvexClientLike } from "../../persistence/convexPersistence.js";
import { JARVIS_DATA_DIR } from "../../persistence/jarvisDataPaths.js";
import { ConvexPreferenceStore } from "../../preferences/convexPreferenceStore.js";
import { ConvexUpgradeStore } from "../../upgrades/convexUpgradeStore.js";
import {
  buildArchiveV4,
  readArchiveV4File,
  writeArchiveV4File,
  type ArchiveV4,
} from "./archive.js";
import {
  readBusinessGroup,
  type BusinessPaths,
  type BusinessRecordsPayload,
} from "./businessSource.js";
import { S4_MAX_PAYLOAD_BYTES } from "./convexCapture.js";
import type { JsonCapture } from "./jsonSource.js";
import { LOCAL_V1_RECEIPT_CAPTURE_VERSION, LOCAL_V1_RECEIPT_TABLES } from "./localV1Receipts.js";
import { S6_CAPTURE_VERSION, S6_TABLES, s6BusinessChecksum } from "./s6MutableQuotes.js";

export const LOCAL_V1_ARCHIVE_FILE = "archive.json";
export const LOCAL_V1_S6_FILE = "convex-s6.json";
export const LOCAL_V1_RECEIPTS_FILE = "convex-receipts.json";
export const LOCAL_V1_BLOB_DIR = "blobs";

const DIGEST = /^sha256:[a-f0-9]{64}$/;

export class LocalV1CaptureError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "LocalV1CaptureError";
  }
}

type EncodedCapture = { payloadJson: string; payloadSha256: string };

export type LocalV1PdfBlob = {
  reference: string;
  digest: string;
  byteLength: number;
  bytes: ArrayBuffer;
};

export type LocalV1ConvexMaterial = {
  s6: EncodedCapture & { restoreVerified: false };
  receipts: EncodedCapture;
};

export type LocalV1Client = ConvexClientLike & {
  action: (
    ref: FunctionReference<"action">,
    args: Record<string, unknown>,
  ) => Promise<LocalV1PdfBlob[]>;
};

const captureLocalV1Query = makeFunctionReference<
  "query",
  {
    serviceToken: string;
    approvalToken: string;
    businessChecksum: string;
    capturedAt: number;
  },
  LocalV1ConvexMaterial
>("backupS6:captureLocalV1");

const readLocalV1BlobsAction = makeFunctionReference<
  "action",
  {
    serviceToken: string;
    approvalToken: string;
    blobs: Array<{ reference: string; storageId: string; byteLength: number }>;
  },
  LocalV1PdfBlob[]
>("backupS6:readLocalV1Blobs");

export type LocalV1CaptureRequest = {
  /** Directory created by this capture. Must not already exist. */
  outputDirectory: string;
  businessPaths: BusinessPaths;
  /** Injected client. This function never constructs one from `CONVEX_URL`. */
  client: LocalV1Client;
  serviceToken: string;
  approvalToken: string;
  /**
   * Identity of the client endpoint. Capture refuses when this equals a
   * forbidden URL, including `process.env.CONVEX_URL` when that is set.
   */
  convexUrl: string;
  capturedAt?: Date;
  forbiddenUrls?: readonly string[];
  /** Additional directories this capture must not write inside. */
  forbiddenWriteRoots?: readonly string[];
};

export type LocalV1CaptureResult = {
  outputDirectory: string;
  archivePath: string;
  archive: ArchiveV4;
};

function readOnlyClient(client: LocalV1Client): LocalV1Client {
  return {
    query: (ref, args) => client.query(ref, args),
    action: (ref, args) => client.action(ref, args),
    mutation: () => {
      throw new LocalV1CaptureError("Local V1 capture refuses Convex writes.");
    },
  };
}

function isInside(parent: string, child: string): boolean {
  const relative = path.relative(parent, child);
  return relative === "" || (!relative.startsWith("..") && !path.isAbsolute(relative));
}

function assertContained(root: string, target: string): void {
  if (!isInside(root, target)) {
    throw new LocalV1CaptureError(
      `Local V1 capture refuses to write outside its output directory: ${target}`,
    );
  }
}

function liveRoots(request: LocalV1CaptureRequest): string[] {
  const roots = new Set<string>([
    path.resolve(JARVIS_DATA_DIR),
    ...(request.forbiddenWriteRoots ?? []).map((root) => path.resolve(root)),
  ]);
  for (const filePath of Object.values(request.businessPaths)) {
    roots.add(path.resolve(path.dirname(filePath)));
  }
  return [...roots];
}

async function assertOutputIsNew(
  outputDirectory: string,
  roots: readonly string[],
): Promise<string> {
  const output = path.resolve(outputDirectory);
  for (const root of roots) {
    if (isInside(root, output) || isInside(output, root)) {
      throw new LocalV1CaptureError(
        "Local V1 capture refuses an output directory that overlaps a live data path.",
      );
    }
  }
  const stat = await fs.lstat(output).catch((error: unknown) => {
    if (error instanceof Error && "code" in error && error.code === "ENOENT") return null;
    throw error;
  });
  if (stat !== null) {
    throw new LocalV1CaptureError(`Local V1 capture output already exists: ${output}`);
  }
  return output;
}

function assertNotLiveUrl(request: LocalV1CaptureRequest): void {
  const url = request.convexUrl.trim();
  if (url.length === 0) {
    throw new LocalV1CaptureError("Local V1 capture requires the Convex endpoint identity.");
  }
  const forbidden = new Set(
    [process.env.CONVEX_URL, ...(request.forbiddenUrls ?? [])]
      .filter((value): value is string => typeof value === "string" && value.trim().length > 0)
      .map((value) => value.trim()),
  );
  if (forbidden.has(url)) {
    throw new LocalV1CaptureError(
      "Local V1 capture refuses to run against CONVEX_URL or another forbidden endpoint.",
    );
  }
}

function bytesOf(value: ArrayBuffer | Uint8Array): Uint8Array {
  return value instanceof Uint8Array ? new Uint8Array(value) : new Uint8Array(value);
}

function object(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function tableNames(
  payloadJson: string,
  expected: readonly string[],
  version: string,
): unknown[][] {
  let parsed: unknown;
  try {
    parsed = JSON.parse(payloadJson) as unknown;
  } catch {
    throw new LocalV1CaptureError("Local V1 Convex capture is not valid JSON.");
  }
  if (!object(parsed) || parsed.version !== version || !Array.isArray(parsed.tables)) {
    throw new LocalV1CaptureError("Local V1 Convex capture is missing its table inventory.");
  }
  if (parsed.tables.length !== expected.length) {
    throw new LocalV1CaptureError("Local V1 Convex capture omitted a required table.");
  }
  const documents: unknown[][] = [];
  for (let index = 0; index < expected.length; index += 1) {
    const entry = parsed.tables[index];
    if (!object(entry) || entry.table !== expected[index] || !Array.isArray(entry.documents)) {
      throw new LocalV1CaptureError(
        `Local V1 Convex capture omitted required table ${expected[index] ?? ""}.`,
      );
    }
    documents.push(entry.documents);
  }
  return documents;
}

function checksum(payload: EncodedCapture, label: string): void {
  if (payload.payloadSha256 !== sha256HexBytes(new TextEncoder().encode(payload.payloadJson))) {
    throw new LocalV1CaptureError(`${label} checksum does not match its payload.`);
  }
}

function validatedBlobs(
  blobs: readonly LocalV1PdfBlob[],
  artifacts: unknown[],
): Array<{ reference: string; digest: string; byteLength: number; bytes: Uint8Array }> {
  const byReference = new Map<string, LocalV1PdfBlob>();
  for (const blob of blobs) {
    if (!DIGEST.test(blob.digest) || byReference.has(blob.reference)) {
      throw new LocalV1CaptureError("Local V1 PDF blob index is invalid.");
    }
    const bytes = bytesOf(blob.bytes);
    if (bytes.byteLength !== blob.byteLength || bytes.byteLength > S4_MAX_PAYLOAD_BYTES) {
      throw new LocalV1CaptureError("S6 capture exceeds its payload byte limit.");
    }
    const digest = `sha256:${sha256HexBytes(bytes)}`;
    if (digest !== blob.digest) {
      throw new LocalV1CaptureError("PDF digest does not match stored bytes.");
    }
    byReference.set(blob.reference, blob);
  }
  if (byReference.size !== artifacts.length) {
    throw new LocalV1CaptureError("PDF bytes are missing for a captured artifact.");
  }
  const validated = [];
  for (const artifact of artifacts) {
    if (!object(artifact) || typeof artifact._id !== "string") {
      throw new LocalV1CaptureError("Captured quotePdfArtifacts row has no id.");
    }
    const reference = `quotePdfArtifacts/${artifact._id}`;
    const blob = byReference.get(reference);
    if (!blob) throw new LocalV1CaptureError(`PDF bytes are missing for ${reference}.`);
    const hex = blob.digest.startsWith("sha256:") ? blob.digest.slice("sha256:".length) : "";
    if (artifact.digest !== `quote-pdf:v1:sha256:${hex}`) {
      throw new LocalV1CaptureError("PDF digest does not match stored bytes.");
    }
    validated.push({
      reference,
      digest: blob.digest,
      byteLength: blob.byteLength,
      bytes: bytesOf(blob.bytes),
    });
  }
  return validated;
}

function classicGroups(archive: BackupArchive): Pick<JsonCapture, "core" | "memory"> {
  return {
    core: { state: archive.state, tasks: archive.tasks, reminders: archive.reminders },
    memory: {
      builds: archive.builds,
      buildLogs: archive.buildLogs,
      upgrades: archive.upgrades,
      assets: archive.assets,
      preferences: archive.preferences,
    },
  };
}

async function writeBytes(filePath: string, bytes: Uint8Array): Promise<void> {
  const handle = await fs.open(filePath, "wx", 0o600);
  try {
    await handle.writeFile(bytes);
    await handle.sync();
  } finally {
    await handle.close();
  }
}

async function fileDigest(filePath: string): Promise<string> {
  const raw = await fs.readFile(filePath);
  return createHash("sha256").update(raw).digest("hex");
}

/**
 * One partial Local V1 archive of the live split.
 *
 * Business JSON is read with `readBusinessGroup`. Tasks, reminders, assistant
 * state, and workshop rows come from `exportBackup` against the injected
 * Convex client. Quote, delivery, tool, and reconciliation rows come from the
 * S6 capture builder. Idempotency receipts are read in that query. `_storage`
 * PDF bytes are read by a follow-up action that does not write. `completeness`
 * stays `partial`.
 *
 * Reads finish before the output directory is created. The only writes are
 * files inside that new directory. A failed source throws and leaves no
 * directory.
 */
export async function captureLocalV1Archive(
  request: LocalV1CaptureRequest,
): Promise<LocalV1CaptureResult> {
  assertNotLiveUrl(request);
  const roots = liveRoots(request);
  const output = await assertOutputIsNew(request.outputDirectory, roots);
  const capturedAt = request.capturedAt ?? new Date();
  const client = readOnlyClient(request.client);
  const before = await Promise.all(
    Object.values(request.businessPaths).map(async (filePath) => {
      const resolved = path.resolve(filePath);
      const stat = await fs.lstat(resolved).catch((error: unknown) => {
        if (error instanceof Error && "code" in error && error.code === "ENOENT") return null;
        throw error;
      });
      if (stat === null) return null;
      if (stat.isSymbolicLink()) {
        throw new StrictBackupError(
          `Backup source ${resolved} is a symbolic link; refusing to follow it.`,
        );
      }
      return fileDigest(resolved);
    }),
  );

  let business: BusinessRecordsPayload;
  let classic: BackupArchive;
  let material: LocalV1ConvexMaterial;
  let blobs: ReturnType<typeof validatedBlobs>;
  try {
    business = await readBusinessGroup(request.businessPaths);
    classic = await exportBackup(
      new ConvexPersistence(client, request.serviceToken),
      () => capturedAt,
      {
        builds: new ConvexBuildStore(client, request.serviceToken),
        buildLogs: new ConvexBuildLogStore(client, request.serviceToken),
        upgrades: new ConvexUpgradeStore(client, request.serviceToken),
        assets: new ConvexAssetStore(client, request.serviceToken),
        preferences: new ConvexPreferenceStore(client, request.serviceToken),
      },
    );
    material = await client.query(captureLocalV1Query, {
      serviceToken: request.serviceToken,
      approvalToken: request.approvalToken,
      businessChecksum: s6BusinessChecksum(business),
      capturedAt: capturedAt.getTime(),
    });
    checksum(material.s6, "S6 capture");
    checksum(material.receipts, "Receipt capture");
    if (material.s6.restoreVerified !== false) {
      throw new LocalV1CaptureError("S6 capture must stay unverified.");
    }
    const s6Tables = tableNames(material.s6.payloadJson, S6_TABLES, S6_CAPTURE_VERSION);
    tableNames(
      material.receipts.payloadJson,
      LOCAL_V1_RECEIPT_TABLES,
      LOCAL_V1_RECEIPT_CAPTURE_VERSION,
    );
    const artifacts = s6Tables[S6_TABLES.indexOf("quotePdfArtifacts")] ?? [];
    const pdfBlobs = await client.action(readLocalV1BlobsAction, {
      serviceToken: request.serviceToken,
      approvalToken: request.approvalToken,
      blobs: artifacts.map((artifact) => {
        if (
          !object(artifact) ||
          typeof artifact._id !== "string" ||
          typeof artifact.storageId !== "string" ||
          typeof artifact.byteLength !== "number"
        ) {
          throw new LocalV1CaptureError("Captured quotePdfArtifacts row is missing storage bytes.");
        }
        return {
          reference: `quotePdfArtifacts/${artifact._id}`,
          storageId: artifact.storageId,
          byteLength: artifact.byteLength,
        };
      }),
    });
    blobs = validatedBlobs(pdfBlobs, artifacts);
  } catch (error: unknown) {
    await assertLiveUnchanged(request.businessPaths, before);
    throw error;
  }
  await assertLiveUnchanged(request.businessPaths, before);
  const groups = classicGroups(classic);
  const archive = buildArchiveV4({ ...groups, businessRecords: business }, capturedAt, {
    consistentSnapshot: false,
    blobs: blobs.map(({ reference, digest, byteLength }) => ({ reference, digest, byteLength })),
  });
  if (archive.manifest.completeness !== "partial") {
    throw new LocalV1CaptureError("Local V1 capture must stay partial.");
  }
  for (const absent of ["notesAndEvidence", "orchestration", "quoteAggregate"] as const) {
    if (!archive.manifest.coverage.absent.includes(absent)) {
      throw new LocalV1CaptureError(`Local V1 capture must leave ${absent} absent.`);
    }
  }

  let created = false;
  try {
    await fs.mkdir(output);
    created = true;
    const blobDir = path.join(output, LOCAL_V1_BLOB_DIR);
    assertContained(output, blobDir);
    await fs.mkdir(blobDir);
    for (const blob of blobs) {
      const hex = blob.digest.slice("sha256:".length);
      const target = path.join(blobDir, hex);
      assertContained(output, target);
      await writeBytes(target, blob.bytes);
    }
    const s6Path = path.join(output, LOCAL_V1_S6_FILE);
    const receiptsPath = path.join(output, LOCAL_V1_RECEIPTS_FILE);
    const archivePath = path.join(output, LOCAL_V1_ARCHIVE_FILE);
    assertContained(output, s6Path);
    assertContained(output, receiptsPath);
    assertContained(output, archivePath);
    await writeBytes(s6Path, new TextEncoder().encode(`${JSON.stringify(material.s6, null, 2)}\n`));
    await writeBytes(
      receiptsPath,
      new TextEncoder().encode(`${JSON.stringify(material.receipts, null, 2)}\n`),
    );
    await writeArchiveV4File(archivePath, archive);
    const reread = await readArchiveV4File(archivePath);
    if (reread.manifest.completeness !== "partial") {
      throw new LocalV1CaptureError("Local V1 capture must stay partial.");
    }
    created = false;
    return { outputDirectory: output, archivePath, archive: reread };
  } catch (error: unknown) {
    if (created) await fs.rm(output, { recursive: true, force: true });
    throw error;
  }
}

async function assertLiveUnchanged(
  paths: BusinessPaths,
  before: Array<string | null>,
): Promise<void> {
  const files = Object.values(paths);
  for (let index = 0; index < files.length; index += 1) {
    const filePath = path.resolve(files[index] ?? "");
    const previous = before[index];
    const stat = await fs.lstat(filePath).catch((error: unknown) => {
      if (error instanceof Error && "code" in error && error.code === "ENOENT") return null;
      throw error;
    });
    if (previous === null) {
      if (stat !== null) {
        throw new LocalV1CaptureError(`Local V1 capture wrote a live business file: ${filePath}`);
      }
      continue;
    }
    if (stat === null || stat.isSymbolicLink() || (await fileDigest(filePath)) !== previous) {
      throw new LocalV1CaptureError(`Local V1 capture changed a live business file: ${filePath}`);
    }
  }
}
