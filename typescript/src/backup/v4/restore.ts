import { createHash } from "node:crypto";
import fs, { type FileHandle } from "node:fs/promises";
import { constants } from "node:fs";
import path from "node:path";
import { isDeepStrictEqual } from "node:util";

import { JsonAssetStore } from "../../assets/jsonAssetStore.js";
import { JsonBusinessSettingsStore } from "../../businessSettings/jsonBusinessSettingsStore.js";
import { JsonClientStore } from "../../clients/jsonClientStore.js";
import { JsonEnquiryStore } from "../../enquiries/jsonEnquiryStore.js";
import { JsonErrandStore } from "../../errands/jsonErrandStore.js";
import { JsonInvoiceStore } from "../../invoices/jsonInvoiceStore.js";
import { JsonProjectStore } from "../../projects/jsonProjectStore.js";
import { JsonPropertyStore } from "../../properties/jsonPropertyStore.js";
import { JsonQuoteStore } from "../../quotes/jsonQuoteStore.js";
import { JsonBuildStore } from "../../builds/jsonBuildStore.js";
import { JsonBuildLogStore } from "../../buildLog/jsonBuildLogStore.js";
import { JARVIS_DATA_DIR } from "../../persistence/jarvisDataPaths.js";
import { JSONPersistence } from "../../persistence/persistence.js";
import { JsonPreferenceStore } from "../../preferences/jsonPreferenceStore.js";
import { JsonUpgradeStore } from "../../upgrades/jsonUpgradeStore.js";
import {
  assertRecoverable,
  groupChecksum,
  type ArchiveManifest,
  type ArchiveVerifiedGroup,
} from "../archiveManifest.js";
import { StrictBackupError } from "../strictValues.js";
import { unresolvedReferencesFor } from "./archive.js";
import type { ArchiveV4 } from "./archive.js";
import { readBusinessGroup } from "./businessSource.js";
import { MAX_MARKER_BYTES } from "./limits.js";
import { readCoreGroup, readMemoryGroup } from "./jsonSource.js";

export const RESTORE_MARKER = ".jarvis-archive-v4-complete.json";

/**
 * Written before the first document and removed only once the restore has
 * verified and completed. Its presence is what makes an interrupted restore
 * *recoverable* rather than merely refused: it names the archive being
 * materialised and every file that restore intends to write, so a resume can
 * prove it is continuing the same work and can verify existing bytes against the archive and retain matching output.
 * A filename alone does not establish ownership.
 */
export const RESTORE_IN_PROGRESS_MARKER = ".jarvis-archive-v4-in-progress.json";

/** Travels with the restored data so the directory is self-describing. */
const MANIFEST_FILE = "manifest.json";

const QUIET = () => {};

const FILENAMES = {
  state: "jarvis-state.json",
  builds: "jarvis-builds.json",
  buildLogs: "jarvis-build-logs.json",
  upgrades: "jarvis-upgrades.json",
  assets: "jarvis-assets.json",
  preferences: "jarvis-preferences.json",
  clients: "jarvis-clients.json",
  properties: "jarvis-properties.json",
  projects: "jarvis-projects.json",
  quotes: "jarvis-quotes.json",
  invoices: "jarvis-invoices.json",
  enquiries: "jarvis-enquiries.json",
  errands: "jarvis-errands.json",
  businessSettings: "jarvis-business-settings.json",
} as const;

export type RestoreV4Result = {
  destination: string;
  manifest: ArchiveManifest;
  markerPath: string;
  /** True when this run continued an interrupted restore rather than starting one. */
  resumed: boolean;
  /**
   * Per-group digests re-derived from the restored documents. This is what a
   * capture seals into its manifest to earn `complete`; on an ordinary restore it
   * is simply the proof this run checked out.
   */
  verifiedGroups: ArchiveVerifiedGroup[];
};

type InProgressMarker = {
  contractVersion: string;
  archiveFingerprint: string;
  startedAt: string;
  plannedFiles: string[];
};

/**
 * Identifies the archive, not the run. Two restores of the same archive produce
 * the same fingerprint, so a resume can tell "continue this work" from "a
 * different archive was being restored into this directory".
 */
export function archiveFingerprint(archive: ArchiveV4): string {
  const canonical = JSON.stringify({
    contractVersion: archive.manifest.contractVersion,
    createdAt: archive.manifest.createdAt,
    groups: archive.manifest.groups.map((entry) => [entry.group, entry.checksum]),
  });
  return `sha256:${createHash("sha256").update(canonical).digest("hex")}`;
}

/** Every file this archive will write, in order. Recorded before the first write. */
function archiveDocuments(archive: ArchiveV4): Array<[keyof typeof FILENAMES, unknown]> {
  const output: Array<[keyof typeof FILENAMES, unknown]> = [];
  if (archive.groups.core) {
    output.push([
      "state",
      {
        version: 2,
        state: archive.groups.core.state,
        tasks: archive.groups.core.tasks,
        reminders: archive.groups.core.reminders,
      },
    ]);
  }

  if (archive.groups.memory) {
    const memory = archive.groups.memory;
    const documents: Array<[keyof typeof FILENAMES, unknown]> = [
      ["builds", { version: 1, builds: memory.builds }],
      ["buildLogs", { version: 1, entries: memory.buildLogs }],
      ["upgrades", { version: 1, entries: memory.upgrades }],
      ["assets", { version: 1, entries: memory.assets }],
      ["preferences", { version: 1, entries: memory.preferences }],
    ];
    output.push(...documents);
  }
  if (archive.groups.businessRecords) {
    const business = archive.groups.businessRecords;
    const documents: Array<[keyof typeof FILENAMES, unknown]> = [
      ["clients", { version: 1, clients: business.clients }],
      ["properties", { version: 1, properties: business.properties }],
      ["projects", { version: 1, projects: business.projects }],
      ["quotes", { version: 1, quotes: business.quotes }],
      ["invoices", { version: 1, invoices: business.invoices }],
      ["enquiries", { version: 1, enquiries: business.enquiries }],
      ["errands", { version: 1, errands: business.errands }],
      // Settings that were never written stay unwritten: the store synthesises
      // defaults on read, so writing a defaults file here would turn "never
      // configured" into "configured with defaults".
      ...(business.businessSettings === null
        ? []
        : ([["businessSettings", { version: 1, settings: business.businessSettings }]] as Array<
            [keyof typeof FILENAMES, unknown]
          >)),
    ];
    output.push(...documents);
  }

  return output;
}

function plannedFiles(archive: ArchiveV4): Array<keyof typeof FILENAMES> {
  return archiveDocuments(archive).map(([key]) => key);
}

function isNodeError(error: unknown): error is NodeJS.ErrnoException {
  return error instanceof Error && "code" in error;
}

/** Resolve existing ancestors even when the final destination/live directory is absent. */
async function physicalPath(target: string): Promise<string> {
  const absolute = path.resolve(target);
  try {
    return await fs.realpath(absolute);
  } catch (error: unknown) {
    if (!isNodeError(error) || error.code !== "ENOENT") throw error;
    const parent = path.dirname(absolute);
    if (parent === absolute) throw error;
    return path.join(await physicalPath(parent), path.basename(absolute));
  }
}

function assertDestinationNotLive(destination: string, liveDir: string): void {
  const dest = path.resolve(destination);
  const live = path.resolve(liveDir);
  const relToLive = path.relative(live, dest);
  const inside =
    relToLive === "" ||
    (relToLive !== ".." && !relToLive.startsWith(`..${path.sep}`) && !path.isAbsolute(relToLive));
  const relFromDest = path.relative(dest, live);
  const contains =
    relFromDest === "" ||
    (relFromDest !== ".." &&
      !relFromDest.startsWith(`..${path.sep}`) &&
      !path.isAbsolute(relFromDest));
  if (inside || contains) {
    throw new StrictBackupError(
      `Refusing to restore into ${dest}: it overlaps the live Jarvis data directory ${live}.`,
    );
  }
}

async function readMarker(target: string): Promise<Record<string, unknown> | null> {
  // Markers are a handful of fields. Anything larger is not a marker this
  // restore wrote, and must not be read wholly into memory to find that out.
  const size = await fs.stat(target).then(
    (entry) => entry.size,
    (error: unknown) => {
      if (isNodeError(error) && error.code === "ENOENT") return null;
      throw error;
    },
  );
  if (size === null) return null;
  if (size > MAX_MARKER_BYTES) {
    throw new StrictBackupError(
      `Restore marker ${target} is ${String(size)} bytes, far larger than any marker this restore writes; refusing to read it.`,
    );
  }
  const raw = await fs.readFile(target, "utf8").catch((error: unknown) => {
    if (isNodeError(error) && error.code === "ENOENT") return null;
    throw error;
  });
  if (raw === null) return null;
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw) as unknown;
  } catch {
    throw new StrictBackupError(`Restore marker ${target} is not valid JSON; refusing to guess.`);
  }
  if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
    throw new StrictBackupError(`Restore marker ${target} is not an object; refusing to guess.`);
  }
  return parsed as Record<string, unknown>;
}

function parseInProgressMarker(value: Record<string, unknown>, target: string): InProgressMarker {
  const files = value.plannedFiles;
  if (
    typeof value.contractVersion !== "string" ||
    typeof value.archiveFingerprint !== "string" ||
    typeof value.startedAt !== "string" ||
    !Array.isArray(files) ||
    files.some((entry) => typeof entry !== "string")
  ) {
    throw new StrictBackupError(`Restore marker ${target} is malformed; refusing to guess.`);
  }
  return {
    contractVersion: value.contractVersion,
    archiveFingerprint: value.archiveFingerprint,
    startedAt: value.startedAt,
    plannedFiles: files as string[],
  };
}

/**
 * Validates archive-derived bytes for every existing output before resuming.
 *
 * The allowed set is computed from the archive being resumed, not from what
 * happens to be on disk, so a forged or stale marker cannot widen it. Any other
 * entry in the directory means this is not purely a leftover restore, and the
 * resume refuses. Matching regular files are retained; changed files are refused.
 */
async function validateInterruptedRestore(
  dest: string,
  archive: ArchiveV4,
  marker: InProgressMarker,
): Promise<Set<string>> {
  const expectedFiles = plannedFiles(archive).map((key) => FILENAMES[key]);
  if (
    marker.contractVersion !== archive.manifest.contractVersion ||
    !isDeepStrictEqual(marker.plannedFiles, expectedFiles)
  ) {
    throw new StrictBackupError(
      `Refusing to resume the restore at ${dest}: its recovery marker does not match the archive. Inspect the directory; no files were removed.`,
    );
  }
  const removable = new Set<string>([...expectedFiles, MANIFEST_FILE, RESTORE_IN_PROGRESS_MARKER]);
  const entries = await fs.readdir(dest, { withFileTypes: true });
  const foreign = entries.filter((entry) => !removable.has(entry.name)).map((entry) => entry.name);
  if (foreign.length > 0) {
    throw new StrictBackupError(
      `Refusing to resume the restore at ${dest}: it holds ${String(foreign.length)} file(s) this restore did not write (${foreign.join(", ")}). Inspect the directory; a resume only retains verified output and writes missing files.`,
    );
  }
  for (const entry of entries) {
    if (!entry.isFile()) {
      throw new StrictBackupError(
        `Refusing to resume the restore at ${dest}: ${entry.name} is not a regular file.`,
      );
    }
  }
  const expected = new Map<string, unknown>(
    archiveDocuments(archive).map(([key, document]) => [FILENAMES[key], document]),
  );
  expected.set(MANIFEST_FILE, archive.manifest);
  // Validate every document before any write. Names establish scope, not ownership.
  // Matching files are retained, so resume never deletes same-name replacements.
  for (const entry of entries) {
    if (entry.name === RESTORE_IN_PROGRESS_MARKER) continue;
    const bytes = Buffer.from(serializeJson(expected.get(entry.name)), "utf8");
    const handle = await fs.open(
      path.join(dest, entry.name),
      constants.O_RDONLY | constants.O_NOFOLLOW,
    );
    try {
      const metadata = await handle.stat();
      if (!metadata.isFile() || metadata.size !== bytes.length) {
        throw new StrictBackupError(
          `Restore output ${entry.name} does not match the archive; no files were changed.`,
        );
      }
      // One extra byte detects growth while bounding reads to the expected output.
      const actual = Buffer.alloc(bytes.length + 1);
      let length = 0;
      while (length < actual.length) {
        const read = await handle.read(actual, length, actual.length - length, length);
        if (read.bytesRead === 0) break;
        length += read.bytesRead;
      }
      if (length !== bytes.length || !actual.subarray(0, length).equals(bytes)) {
        throw new StrictBackupError(
          `Restore output ${entry.name} does not match the archive; no files were changed.`,
        );
      }
    } finally {
      await handle.close();
    }
  }
  return new Set(entries.map((entry) => entry.name));
}

export type DestinationState =
  | { kind: "fresh" }
  | { kind: "completed" }
  | { kind: "interrupted"; marker: InProgressMarker }
  | { kind: "foreign"; entries: string[] };

/**
 * Classifies an existing destination so the caller — and the operator — get a
 * named condition instead of a bare "already exists".
 */
export async function inspectDestination(destination: string): Promise<DestinationState> {
  const dest = path.resolve(destination);
  const existing = await fs.lstat(dest).catch((error: unknown) => {
    if (isNodeError(error) && error.code === "ENOENT") return null;
    throw error;
  });
  if (existing === null) return { kind: "fresh" };
  if (existing.isSymbolicLink()) {
    throw new StrictBackupError(`Restore destination ${dest} is a symbolic link; refusing.`);
  }
  if (!existing.isDirectory()) {
    throw new StrictBackupError(`Restore destination ${dest} exists and is not a directory.`);
  }
  if ((await readMarker(path.join(dest, RESTORE_MARKER))) !== null) return { kind: "completed" };
  const inProgress = await readMarker(path.join(dest, RESTORE_IN_PROGRESS_MARKER));
  if (inProgress !== null) {
    return {
      kind: "interrupted",
      marker: parseInProgressMarker(inProgress, path.join(dest, RESTORE_IN_PROGRESS_MARKER)),
    };
  }
  return { kind: "foreign", entries: (await fs.readdir(dest)).sort() };
}

/**
 * Reserves the destination, or recovers one this restore left behind.
 *
 * A fresh destination is created with an exclusive `mkdir`. An existing one is
 * never merged into: a completed restore, a foreign directory and an
 * interrupted restore of a *different* archive are all refused by name. Only an
 * interrupted restore of this same archive can be resumed, and only when the
 * caller asks for it — so recovery is an explicit operator decision, never
 * something that happens silently on a retry.
 */
async function prepareDestination(
  destination: string,
  archive: ArchiveV4,
  resume: boolean,
): Promise<{ dest: string; resumed: boolean; retainedFiles: Set<string> }> {
  const dest = path.resolve(destination);
  const state = await inspectDestination(dest);

  if (state.kind === "completed") {
    throw new StrictBackupError(
      `Restore destination ${dest} already holds a completed restore. Restoring again would overwrite recovered data; use a new destination.`,
    );
  }
  if (state.kind === "foreign") {
    throw new StrictBackupError(
      `Restore destination ${dest} already exists and was not written by a restore (${state.entries.length === 0 ? "it is empty" : `holds: ${state.entries.join(", ")}`}); refusing to merge into or overwrite it.`,
    );
  }
  if (state.kind === "interrupted") {
    const fingerprint = archiveFingerprint(archive);
    if (state.marker.archiveFingerprint !== fingerprint) {
      throw new StrictBackupError(
        `Restore destination ${dest} holds an interrupted restore of a different archive (started ${state.marker.startedAt}). Refusing; use a new destination, or remove that directory deliberately.`,
      );
    }
    if (!resume) {
      throw new StrictBackupError(
        `Restore destination ${dest} holds an interrupted restore of this archive, started ${state.marker.startedAt}. It is incomplete and must not be used as recovered data. Re-run with --resume to verify existing output and restore missing files, or remove the directory.`,
      );
    }
    const retainedFiles = await validateInterruptedRestore(dest, archive, state.marker);
    return { dest, resumed: true, retainedFiles };
  }

  try {
    await fs.mkdir(dest, { recursive: false, mode: 0o700 });
  } catch (error: unknown) {
    if (isNodeError(error) && error.code === "EEXIST") {
      throw new StrictBackupError(
        `Restore destination ${dest} was created by another process; refusing.`,
      );
    }
    if (isNodeError(error) && error.code === "ENOENT") {
      throw new StrictBackupError(
        `Restore destination ${dest} cannot be created: its parent directory does not exist.`,
      );
    }
    throw error;
  }
  return { dest, resumed: false, retainedFiles: new Set() };
}

/**
 * Writes one group's documents in order, honouring the failure-injection hook so
 * a drill can interrupt the restore at any named file.
 */
async function writeDocuments(
  destDir: string,
  documents: ReadonlyArray<[keyof typeof FILENAMES, unknown]>,
  written: Array<keyof typeof FILENAMES>,
  options: Pick<RestoreOptions, "injectAfterWrite">,
  retainedFiles: ReadonlySet<string>,
): Promise<void> {
  for (const [key, document] of documents) {
    if (!retainedFiles.has(FILENAMES[key])) {
      await writeJson(path.join(destDir, FILENAMES[key]), document);
    }
    written.push(key);
    if (options.injectAfterWrite === key) {
      throw new StrictBackupError(
        `Injected failure after writing ${key}; restore left incomplete at ${destDir}.`,
      );
    }
  }
}

function serializeJson(document: unknown): string {
  return `${JSON.stringify(document, null, 2)}\n`;
}

async function writeJson(target: string, document: unknown): Promise<void> {
  let handle: FileHandle | undefined;
  try {
    handle = await fs.open(target, "wx", 0o600);
    await handle.writeFile(serializeJson(document), "utf8");
    await handle.sync();
  } finally {
    await handle?.close().catch(() => undefined);
  }
}

async function fsyncDir(dir: string): Promise<void> {
  let handle: FileHandle | undefined;
  try {
    handle = await fs.open(dir, "r");
    await handle.sync();
  } catch (error: unknown) {
    if (
      isNodeError(error) &&
      (error.code === "EISDIR" || error.code === "EPERM" || error.code === "EINVAL")
    ) {
      return;
    }
    throw error;
  } finally {
    await handle?.close().catch(() => undefined);
  }
}

function compare(
  section: string,
  expected: readonly unknown[],
  actual: readonly unknown[],
  via: string,
): void {
  if (actual.length !== expected.length) {
    throw new StrictBackupError(
      `Restore verification failed (${via}): ${section} has ${actual.length} record(s), expected ${expected.length}.`,
    );
  }
  for (let index = 0; index < expected.length; index += 1) {
    if (!isDeepStrictEqual(actual[index], expected[index])) {
      const id = (expected[index] as { id?: string } | undefined)?.id ?? `#${index}`;
      throw new StrictBackupError(
        `Restore verification failed (${via}): ${section} record ${id} does not match the archive.`,
      );
    }
  }
}

/**
 * Two-way verification: re-read every written document with the strict readers,
 * then re-read the same files through fresh ordinary runtime stores. If normal
 * loading changes any recovered value — a false-success write, or runtime
 * normalisation — this fails rather than reporting success.
 *
 * Returns the evidence that a pass actually happened: for each group, the digest
 * of the payload rebuilt from what the strict readers just read off disk. The
 * digest is computed from that re-read value, never copied from the manifest, so
 * it can only match when the round-trip really preserved the captured bytes.
 * `sealVerifiedArchive` turns this into the manifest's `verification` record.
 */
export async function verifyRestoredGroups(
  destDir: string,
  archive: ArchiveV4,
): Promise<ArchiveVerifiedGroup[]> {
  const file = (key: keyof typeof FILENAMES): string => path.join(destDir, FILENAMES[key]);
  const evidence: ArchiveVerifiedGroup[] = [];
  // The payloads as rebuilt from disk. Everything below is derived from these
  // rather than from `archive.groups`, so the checks are direct readings of what
  // the restore actually produced instead of inferences from an earlier compare.
  const restored: ArchiveV4["groups"] = {};

  if (archive.groups.core) {
    const strict = await readCoreGroup(file("state"));
    if (!isDeepStrictEqual(strict.state, archive.groups.core.state)) {
      throw new StrictBackupError(
        "Restore verification failed (strict re-read): assistant state does not match the archive.",
      );
    }
    compare("tasks", archive.groups.core.tasks, strict.tasks, "strict re-read");
    compare("reminders", archive.groups.core.reminders, strict.reminders, "strict re-read");

    const snapshot = await new JSONPersistence(file("state"), QUIET).snapshot();
    if (!isDeepStrictEqual(snapshot.state, archive.groups.core.state)) {
      throw new StrictBackupError(
        "Restore verification failed (runtime store): assistant state changed on normal load.",
      );
    }
    compare("tasks", archive.groups.core.tasks, snapshot.tasks, "runtime store");
    compare("reminders", archive.groups.core.reminders, snapshot.reminders, "runtime store");
    restored.core = strict;
    evidence.push({ group: "core", restoredChecksum: groupChecksum(strict) });
  }

  if (archive.groups.memory) {
    const memory = archive.groups.memory;
    const strict = await readMemoryGroup({
      builds: file("builds"),
      buildLogs: file("buildLogs"),
      upgrades: file("upgrades"),
      assets: file("assets"),
      preferences: file("preferences"),
    });
    compare("builds", memory.builds, strict.builds, "strict re-read");
    compare("buildLogs", memory.buildLogs, strict.buildLogs, "strict re-read");
    compare("upgrades", memory.upgrades, strict.upgrades, "strict re-read");
    compare("assets", memory.assets, strict.assets, "strict re-read");
    compare("preferences", memory.preferences, strict.preferences, "strict re-read");

    compare(
      "builds",
      memory.builds,
      await new JsonBuildStore(file("builds"), QUIET).list(),
      "runtime store",
    );
    compare(
      "buildLogs",
      memory.buildLogs,
      await new JsonBuildLogStore(file("buildLogs"), QUIET).list(),
      "runtime store",
    );
    compare(
      "upgrades",
      memory.upgrades,
      await new JsonUpgradeStore(file("upgrades"), QUIET).list(),
      "runtime store",
    );
    compare(
      "assets",
      memory.assets,
      await new JsonAssetStore(file("assets"), QUIET).list(),
      "runtime store",
    );
    compare(
      "preferences",
      memory.preferences,
      await new JsonPreferenceStore(file("preferences"), QUIET).list(),
      "runtime store",
    );
    restored.memory = strict;
    evidence.push({ group: "memory", restoredChecksum: groupChecksum(strict) });
  }

  if (archive.groups.businessRecords) {
    const business = archive.groups.businessRecords;
    const strict = await readBusinessGroup({
      clients: file("clients"),
      properties: file("properties"),
      projects: file("projects"),
      quotes: file("quotes"),
      invoices: file("invoices"),
      enquiries: file("enquiries"),
      errands: file("errands"),
      businessSettings: file("businessSettings"),
    });
    compare("clients", business.clients, strict.clients, "strict re-read");
    compare("properties", business.properties, strict.properties, "strict re-read");
    compare("projects", business.projects, strict.projects, "strict re-read");
    compare("quotes", business.quotes, strict.quotes, "strict re-read");
    compare("invoices", business.invoices, strict.invoices, "strict re-read");
    compare("enquiries", business.enquiries, strict.enquiries, "strict re-read");
    compare("errands", business.errands, strict.errands, "strict re-read");
    if (!isDeepStrictEqual(strict.businessSettings, business.businessSettings)) {
      throw new StrictBackupError(
        "Restore verification failed (strict re-read): business settings do not match the archive.",
      );
    }

    compare(
      "clients",
      business.clients,
      await new JsonClientStore(file("clients"), QUIET).list(),
      "runtime store",
    );
    compare(
      "properties",
      business.properties,
      await new JsonPropertyStore(file("properties"), QUIET).list(),
      "runtime store",
    );
    compare(
      "projects",
      business.projects,
      await new JsonProjectStore(file("projects"), QUIET).list(),
      "runtime store",
    );
    compare(
      "quotes",
      business.quotes,
      await new JsonQuoteStore(file("quotes"), QUIET).list(),
      "runtime store",
    );
    compare(
      "invoices",
      business.invoices,
      await new JsonInvoiceStore(file("invoices"), QUIET).list(),
      "runtime store",
    );
    compare(
      "enquiries",
      business.enquiries,
      await new JsonEnquiryStore(file("enquiries"), QUIET).list(),
      "runtime store",
    );
    compare(
      "errands",
      business.errands,
      await new JsonErrandStore(file("errands"), QUIET).list(),
      "runtime store",
    );
    if (business.businessSettings !== null) {
      const runtime = await new JsonBusinessSettingsStore(file("businessSettings"), QUIET).get();
      if (!isDeepStrictEqual(runtime, business.businessSettings)) {
        throw new StrictBackupError(
          "Restore verification failed (runtime store): business settings changed on normal load.",
        );
      }
    }
    restored.businessRecords = strict;
    evidence.push({ group: "businessRecords", restoredChecksum: groupChecksum(strict) });
  }

  {
    // Derived from what was just read back off disk, not copied from the
    // manifest: this is what stops an archive from understating a broken edge it
    // carries, or claiming one it does not.
    const rederived = unresolvedReferencesFor(restored);
    if (!isDeepStrictEqual(rederived, archive.manifest.unresolvedReferences)) {
      throw new StrictBackupError(
        `Restore verification failed: the manifest declares ${String(
          archive.manifest.unresolvedReferences.length,
        )} unresolved reference(s), the restored data has ${String(rederived.length)}.`,
      );
    }
  }

  return evidence;
}

export type RestoreOptions = {
  liveDataDir?: string;
  now?: () => Date;
  /**
   * Acknowledges that a partial archive is being materialised for staged
   * development and is NOT a recovery. Without it, a partial archive is refused.
   */
  allowPartial?: boolean;
  /**
   * Continues an interrupted restore of this same archive: retains exact matching
   * output and writes missing files. Changed or truncated files are refused.
   */
  resume?: boolean;
  /** Drill hook: throw after this file is written. */
  injectAfterWrite?: keyof typeof FILENAMES;
  /** Drill hook: throw between verification and the completion marker. */
  injectAfterVerify?: boolean;
};

/**
 * Materialises an archive into a freshly reserved, empty destination, preserving
 * every logical id, timestamp and array order verbatim. Never merges, never
 * overwrites, never touches live storage, and writes nothing outside the
 * destination directory.
 *
 * A failure at any point leaves an unmistakably incomplete directory: the
 * in-progress marker is still there and the completion marker is not. A plain
 * retry refuses it by name; `resume` validates all existing output against the
 * archive and retains matching files before writing missing ones. Physical path
 * checks prevent static symlink aliases; callers must keep the destination and
 * its ancestors exclusive against concurrent filesystem modification.
 */
export async function restoreArchiveV4(
  archive: ArchiveV4,
  destination: string,
  options: RestoreOptions = {},
): Promise<RestoreV4Result> {
  if (!options.allowPartial) {
    // The full-recovery path. Refuses a partial archive by contract.
    assertRecoverable(archive.manifest);
  }

  const liveDirectory = options.liveDataDir ?? JARVIS_DATA_DIR;
  assertDestinationNotLive(destination, liveDirectory);
  const finalEntry = await fs.lstat(path.resolve(destination)).catch((error: unknown) => {
    if (isNodeError(error) && error.code === "ENOENT") return null;
    throw error;
  });
  if (finalEntry?.isSymbolicLink()) {
    throw new StrictBackupError(`Restore destination ${destination} is a symbolic link; refusing.`);
  }
  const physicalDestination = await physicalPath(destination);
  assertDestinationNotLive(physicalDestination, await physicalPath(liveDirectory));
  const now = options.now ?? ((): Date => new Date());
  const {
    dest: destDir,
    resumed,
    retainedFiles,
  } = await prepareDestination(physicalDestination, archive, options.resume ?? false);

  // Written before the first document, so an interruption at any point after
  // this leaves a directory that says what it is and what it was going to hold.
  const inProgress: InProgressMarker = {
    contractVersion: archive.manifest.contractVersion,
    archiveFingerprint: archiveFingerprint(archive),
    startedAt: now().toISOString(),
    plannedFiles: plannedFiles(archive).map((key) => FILENAMES[key]),
  };
  if (!resumed) await writeJson(path.join(destDir, RESTORE_IN_PROGRESS_MARKER), inProgress);
  await fsyncDir(destDir);

  const written: Array<keyof typeof FILENAMES> = [];
  await writeDocuments(destDir, archiveDocuments(archive), written, options, retainedFiles);

  // The restored directory is self-describing: the manifest travels with it, so
  // a partial restore cannot later be mistaken for a recovery image.
  if (!retainedFiles.has(MANIFEST_FILE)) {
    await writeJson(path.join(destDir, MANIFEST_FILE), archive.manifest);
  }
  await fsyncDir(destDir);

  const verifiedGroups = await verifyRestoredGroups(destDir, archive);
  if (options.injectAfterVerify) {
    throw new StrictBackupError(
      `Injected failure after verification; restore left incomplete at ${destDir}.`,
    );
  }

  const markerPath = path.join(destDir, RESTORE_MARKER);
  await writeJson(markerPath, {
    contractVersion: archive.manifest.contractVersion,
    completeness: archive.manifest.completeness,
    restoredAt: now().toISOString(),
    resumed,
    groups: archive.manifest.coverage.present,
    absentGroups: archive.manifest.coverage.absent,
    unresolvedReferences: archive.manifest.unresolvedReferences,
    files: written.map((key) => FILENAMES[key]),
  });
  await fsyncDir(destDir);

  // Only now is the restore no longer "in progress". Removing this last means a
  // failure at any earlier point leaves the directory unmistakably incomplete.
  await fs.rm(path.join(destDir, RESTORE_IN_PROGRESS_MARKER), { force: true });
  await fsyncDir(destDir);

  return { destination: destDir, manifest: archive.manifest, markerPath, resumed, verifiedGroups };
}
