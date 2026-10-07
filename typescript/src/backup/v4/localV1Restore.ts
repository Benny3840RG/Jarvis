import fs from "node:fs/promises";
import path from "node:path";

import { makeFunctionReference, type FunctionReference } from "convex/server";

import { sha256HexBytes } from "../../actions/sha256.js";
import { JARVIS_DATA_DIR } from "../../persistence/jarvisDataPaths.js";
import { readArchiveV4File, type ArchiveV4 } from "./archive.js";
import type { BusinessRecordsPayload } from "./businessSource.js";
import { S4_MAX_PAYLOAD_BYTES } from "./convexCapture.js";
import {
  LOCAL_V1_ARCHIVE_FILE,
  LOCAL_V1_BLOB_DIR,
  LOCAL_V1_RECEIPTS_FILE,
  LOCAL_V1_S6_FILE,
} from "./localV1Capture.js";
import { LOCAL_V1_RECEIPT_CAPTURE_VERSION, LOCAL_V1_RECEIPT_TABLES } from "./localV1Receipts.js";
import { restoreArchiveV4 } from "./restore.js";
import { S6_CAPTURE_VERSION, S6_TABLES } from "./s6MutableQuotes.js";

export class LocalV1RestoreError extends Error {
  constructor(message: string, options?: ErrorOptions) {
    super(message, options);
    this.name = "LocalV1RestoreError";
  }
}

export type LocalV1RestoreMaps = {
  tasks: Array<{ sourceId: string; targetId: string }>;
  reminders: Array<{ sourceId: string; targetId: string }>;
  builds: Array<{ sourceId: string; targetId: string }>;
  pdfs: Array<{ reference: string; storageId: string; digest: string }>;
};

export type LocalV1RestoreClient = {
  action: (
    ref: FunctionReference<"action">,
    args: Record<string, unknown>,
  ) => Promise<LocalV1RestoreMaps>;
};

export type LocalV1RestoreRequest = {
  /** Directory written by `captureLocalV1Archive`. Read only. */
  captureDirectory: string;
  /** New directory for the JSON half. Must not already exist. */
  jsonDirectory: string;
  /** Empty `convex-test` client. This function never constructs one from `CONVEX_URL`. */
  client: LocalV1RestoreClient;
  serviceToken: string;
  approvalToken: string;
  /**
   * Identity of the Convex target. Restore refuses when this equals
   * `process.env.CONVEX_URL` or another forbidden URL.
   */
  convexUrl: string;
  /** Clock used to reject an approval that has not expired yet. */
  now: number;
  liveDataDir?: string;
  forbiddenUrls?: readonly string[];
  forbiddenWriteRoots?: readonly string[];
};

export type LocalV1RestoreResult = {
  jsonDirectory: string;
  archive: ArchiveV4;
  maps: LocalV1RestoreMaps;
};

const restoreLocalV1Action = makeFunctionReference<
  "action",
  {
    serviceToken: string;
    approvalToken: string;
    now: number;
    payloadJson: string;
    blobs: Array<{ reference: string; bytes: ArrayBuffer }>;
  },
  LocalV1RestoreMaps
>("backupLocalV1Restore:restoreLocalV1");

function object(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isInside(parent: string, child: string): boolean {
  const relative = path.relative(parent, child);
  return relative === "" || (!relative.startsWith("..") && !path.isAbsolute(relative));
}

function isNodeError(error: unknown): error is NodeJS.ErrnoException {
  return error instanceof Error && "code" in error;
}

/** Resolve existing ancestors even when the final JSON directory is absent. */
async function physicalPath(target: string): Promise<string> {
  const absolute = path.resolve(target);
  try {
    return await fs.realpath(absolute);
  } catch (error: unknown) {
    if (!isNodeError(error) || error.code !== "ENOENT") throw error;
    const entry = await fs.lstat(absolute).catch((statError: unknown) => {
      if (isNodeError(statError) && statError.code === "ENOENT") return null;
      throw statError;
    });
    if (entry?.isSymbolicLink()) {
      throw new LocalV1RestoreError(
        `Cannot establish restore isolation through dangling symbolic link ${absolute}.`,
      );
    }
    const parent = path.dirname(absolute);
    if (parent === absolute) throw error;
    return path.join(await physicalPath(parent), path.basename(absolute));
  }
}

function assertTarget(request: LocalV1RestoreRequest): void {
  const url = request.convexUrl.trim();
  if (url.length === 0)
    throw new LocalV1RestoreError("Local V1 restore requires the Convex target identity.");
  const forbidden = new Set(
    [process.env.CONVEX_URL, ...(request.forbiddenUrls ?? [])]
      .filter((value): value is string => typeof value === "string" && value.trim().length > 0)
      .map((value) => value.trim()),
  );
  if (forbidden.has(url)) {
    throw new LocalV1RestoreError(
      "Local V1 restore refuses CONVEX_URL. The target must be an empty injected database.",
    );
  }
}

async function assertJsonDestination(request: LocalV1RestoreRequest): Promise<string> {
  const destination = path.resolve(request.jsonDirectory);
  const capture = path.resolve(request.captureDirectory);
  const roots = [
    path.resolve(request.liveDataDir ?? JARVIS_DATA_DIR),
    capture,
    ...(request.forbiddenWriteRoots ?? []).map((root) => path.resolve(root)),
  ];
  const physicalDestination = await physicalPath(destination);
  const compared = [
    [destination, roots],
    [physicalDestination, await Promise.all(roots.map((root) => physicalPath(root)))],
  ] as const;
  for (const [child, parents] of compared) {
    for (const root of parents) {
      if (isInside(root, child) || isInside(child, root)) {
        throw new LocalV1RestoreError(
          "Local V1 restore refuses a JSON directory that overlaps live data.",
        );
      }
    }
  }
  const stat = await fs.lstat(destination).catch((error: unknown) => {
    if (error instanceof Error && "code" in error && error.code === "ENOENT") return null;
    throw error;
  });
  if (stat !== null)
    throw new LocalV1RestoreError(`Local V1 restore JSON directory already exists: ${destination}`);
  return destination;
}

async function readSidecar(
  filePath: string,
  version: string,
  tables: readonly string[],
): Promise<unknown[]> {
  const raw = await fs.readFile(filePath, "utf8");
  if (new TextEncoder().encode(raw).length > S4_MAX_PAYLOAD_BYTES) {
    throw new LocalV1RestoreError("Local V1 restore sidecar exceeds its payload byte limit.");
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw) as unknown;
  } catch (error: unknown) {
    throw new LocalV1RestoreError("Local V1 restore sidecar is not valid JSON.", { cause: error });
  }
  if (
    !object(parsed) ||
    typeof parsed.payloadJson !== "string" ||
    typeof parsed.payloadSha256 !== "string"
  ) {
    throw new LocalV1RestoreError("Local V1 restore sidecar is missing its payload.");
  }
  if (sha256HexBytes(new TextEncoder().encode(parsed.payloadJson)) !== parsed.payloadSha256) {
    throw new LocalV1RestoreError("Local V1 restore sidecar checksum does not match its payload.");
  }
  let payload: unknown;
  try {
    payload = JSON.parse(parsed.payloadJson) as unknown;
  } catch (error: unknown) {
    throw new LocalV1RestoreError("Local V1 restore sidecar payload is not valid JSON.", {
      cause: error,
    });
  }
  if (!object(payload) || payload.version !== version || !Array.isArray(payload.tables)) {
    throw new LocalV1RestoreError("Local V1 restore sidecar omitted a required table.");
  }
  if (payload.tables.length !== tables.length) {
    throw new LocalV1RestoreError("Local V1 restore sidecar omitted a required table.");
  }
  for (let index = 0; index < tables.length; index += 1) {
    const entry = payload.tables[index];
    if (!object(entry) || entry.table !== tables[index] || !Array.isArray(entry.documents)) {
      throw new LocalV1RestoreError(
        `Local V1 restore omitted required table ${tables[index] ?? ""}.`,
      );
    }
  }
  return payload.tables;
}

function quoteIds(tables: unknown[]): {
  convex: Set<string>;
  artifacts: Array<{ id: string; digest: string }>;
} {
  const quotes = tables[S6_TABLES.indexOf("quotes")];
  const artifacts = tables[S6_TABLES.indexOf("quotePdfArtifacts")];
  if (
    !object(quotes) ||
    !Array.isArray(quotes.documents) ||
    !object(artifacts) ||
    !Array.isArray(artifacts.documents)
  ) {
    throw new LocalV1RestoreError("Local V1 restore omitted a required table.");
  }
  const convex = new Set<string>();
  for (const row of quotes.documents) {
    if (!object(row) || typeof row.quoteId !== "string") {
      throw new LocalV1RestoreError("Local V1 restore quote identity is missing or duplicated.");
    }
    convex.add(row.quoteId);
  }
  const pdfs: Array<{ id: string; digest: string }> = [];
  for (const row of artifacts.documents) {
    if (!object(row) || typeof row._id !== "string" || typeof row.digest !== "string") {
      throw new LocalV1RestoreError("Local V1 restore PDF artifact is missing its digest.");
    }
    pdfs.push({ id: row._id, digest: row.digest });
  }
  return { convex, artifacts: pdfs };
}

function assertInvoiceLinks(business: BusinessRecordsPayload, convexQuoteIds: Set<string>): void {
  const flat = new Set(business.quotes.map((row) => row.id));
  const clients = new Set(business.clients.map((row) => row.id));
  for (const invoice of business.invoices) {
    if (
      invoice.quoteId !== undefined &&
      !flat.has(invoice.quoteId) &&
      !convexQuoteIds.has(invoice.quoteId)
    ) {
      throw new LocalV1RestoreError(
        `Local V1 restore invoice quote ${invoice.quoteId} matches neither store.`,
      );
    }
    if (!clients.has(invoice.clientId)) {
      throw new LocalV1RestoreError(
        "Local V1 restore invoice client is not in the business archive.",
      );
    }
  }
}

/**
 * Restores one partial Local V1 capture into a new JSON directory and an
 * injected empty Convex database. `completeness` stays partial.
 * `restoreS6MutableQuotes` is not called.
 */
export async function restoreLocalV1Archive(
  request: LocalV1RestoreRequest,
): Promise<LocalV1RestoreResult> {
  assertTarget(request);
  if (!Number.isSafeInteger(request.now) || request.now < 0) {
    throw new LocalV1RestoreError("Invalid Local V1 restore clock.");
  }
  const destination = await assertJsonDestination(request);
  const capture = path.resolve(request.captureDirectory);
  const archive = await readArchiveV4File(path.join(capture, LOCAL_V1_ARCHIVE_FILE));
  if (archive.manifest.completeness !== "partial") {
    throw new LocalV1RestoreError("Local V1 restore refuses an archive that is not partial.");
  }
  const business = archive.groups.businessRecords;
  const core = archive.groups.core;
  const memory = archive.groups.memory;
  if (!business || !core || !memory)
    throw new LocalV1RestoreError("Local V1 restore archive is missing a group.");
  const s6Tables = await readSidecar(
    path.join(capture, LOCAL_V1_S6_FILE),
    S6_CAPTURE_VERSION,
    S6_TABLES,
  );
  const receiptTables = await readSidecar(
    path.join(capture, LOCAL_V1_RECEIPTS_FILE),
    LOCAL_V1_RECEIPT_CAPTURE_VERSION,
    LOCAL_V1_RECEIPT_TABLES,
  );
  const linked = quoteIds(s6Tables);
  assertInvoiceLinks(business, linked.convex);
  const blobDir = path.join(capture, LOCAL_V1_BLOB_DIR);
  const blobs: Array<{ reference: string; bytes: ArrayBuffer }> = [];
  for (const artifact of linked.artifacts) {
    const reference = `quotePdfArtifacts/${artifact.id}`;
    const listed = archive.manifest.blobs.find((blob) => blob.reference === reference);
    const hex = artifact.digest.startsWith("quote-pdf:v1:sha256:")
      ? artifact.digest.slice("quote-pdf:v1:sha256:".length)
      : "";
    if (!listed || listed.digest !== `sha256:${hex}`) {
      throw new LocalV1RestoreError(`PDF bytes are missing for ${reference}.`);
    }
    const filePath = path.join(blobDir, hex);
    const bytes = await fs.readFile(filePath).catch((error: unknown) => {
      if (error instanceof Error && "code" in error && error.code === "ENOENT") {
        throw new LocalV1RestoreError(`PDF bytes are missing for ${reference}.`);
      }
      throw error;
    });
    if (sha256HexBytes(bytes) !== hex || bytes.byteLength !== listed.byteLength) {
      throw new LocalV1RestoreError("PDF digest does not match stored bytes.");
    }
    blobs.push({
      reference,
      bytes: bytes.buffer.slice(
        bytes.byteOffset,
        bytes.byteOffset + bytes.byteLength,
      ) as ArrayBuffer,
    });
  }
  if (blobs.length !== archive.manifest.blobs.length) {
    throw new LocalV1RestoreError("PDF bytes are missing for a captured artifact.");
  }
  const payloadJson = JSON.stringify({
    core,
    memory,
    business: {
      clientIds: business.clients.map((row) => row.id),
      projectIds: business.projects.map((row) => row.id),
      flatQuoteIds: business.quotes.map((row) => row.id),
      invoiceQuoteIds: business.invoices.flatMap((row) =>
        row.quoteId === undefined ? [] : [row.quoteId],
      ),
    },
    s6: s6Tables,
    receipts: receiptTables,
  });

  await restoreArchiveV4(archive, destination, {
    allowPartial: true,
    liveDataDir: request.liveDataDir ?? JARVIS_DATA_DIR,
    now: () => new Date(request.now),
  });
  try {
    const maps = await request.client.action(restoreLocalV1Action, {
      serviceToken: request.serviceToken,
      approvalToken: request.approvalToken,
      now: request.now,
      payloadJson,
      blobs,
    });
    return { jsonDirectory: destination, archive, maps };
  } catch (error: unknown) {
    await fs.rm(destination, { recursive: true, force: true });
    throw error;
  }
}
