import fs, { type FileHandle } from "node:fs/promises";
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
import { assertRecoverable, type ArchiveManifest } from "../archiveManifest.js";
import { StrictBackupError } from "../strictValues.js";
import { unresolvedReferencesFor } from "./archive.js";
import type { ArchiveV4 } from "./archive.js";
import { readBusinessGroup } from "./businessSource.js";
import { readCoreGroup, readMemoryGroup } from "./jsonSource.js";

export const RESTORE_MARKER = ".jarvis-archive-v4-complete.json";

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
};

function isNodeError(error: unknown): error is NodeJS.ErrnoException {
  return error instanceof Error && "code" in error;
}

function assertDestinationNotLive(destination: string, liveDir: string): void {
  const dest = path.resolve(destination);
  const live = path.resolve(liveDir);
  const relToLive = path.relative(live, dest);
  const inside = relToLive === "" || (!relToLive.startsWith("..") && !path.isAbsolute(relToLive));
  const relFromDest = path.relative(dest, live);
  const contains =
    relFromDest === "" || (!relFromDest.startsWith("..") && !path.isAbsolute(relFromDest));
  if (inside || contains) {
    throw new StrictBackupError(
      `Refusing to restore into ${dest}: it overlaps the live Jarvis data directory ${live}.`,
    );
  }
}

/**
 * Reserves the destination. `fs.mkdir` (non-recursive) is the reservation
 * primitive: `EEXIST` means either a real directory or a prior incomplete
 * restore, and either way this refuses — never merge, never overwrite.
 */
async function reserveDestination(destination: string): Promise<string> {
  const dest = path.resolve(destination);
  const existing = await fs.lstat(dest).catch((error: unknown) => {
    if (isNodeError(error) && error.code === "ENOENT") return null;
    throw error;
  });
  if (existing !== null) {
    if (existing.isSymbolicLink()) {
      throw new StrictBackupError(`Restore destination ${dest} is a symbolic link; refusing.`);
    }
    throw new StrictBackupError(
      `Restore destination ${dest} already exists; refusing to merge into or overwrite it. A leftover from a failed restore must be removed by an operator.`,
    );
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
  return dest;
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
): Promise<void> {
  for (const [key, document] of documents) {
    await writeJson(path.join(destDir, FILENAMES[key]), document);
    written.push(key);
    if (options.injectAfterWrite === key) {
      throw new StrictBackupError(
        `Injected failure after writing ${key}; restore left incomplete at ${destDir}.`,
      );
    }
  }
}

async function writeJson(target: string, document: unknown): Promise<void> {
  let handle: FileHandle | undefined;
  try {
    handle = await fs.open(target, "wx", 0o600);
    await handle.writeFile(`${JSON.stringify(document, null, 2)}\n`, "utf8");
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
 */
export async function verifyRestoredGroups(destDir: string, archive: ArchiveV4): Promise<void> {
  const file = (key: keyof typeof FILENAMES): string => path.join(destDir, FILENAMES[key]);

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
  }

  {
    // Derived from what was just read back off disk, not copied from the
    // manifest: this is what stops an archive from understating a broken edge it
    // carries, or claiming one it does not.
    const rederived = unresolvedReferencesFor(archive.groups);
    if (!isDeepStrictEqual(rederived, archive.manifest.unresolvedReferences)) {
      throw new StrictBackupError(
        `Restore verification failed: the manifest declares ${String(
          archive.manifest.unresolvedReferences.length,
        )} unresolved reference(s), the restored data has ${String(rederived.length)}.`,
      );
    }
  }
}

export type RestoreOptions = {
  liveDataDir?: string;
  now?: () => Date;
  /**
   * Acknowledges that a partial archive is being materialised for staged
   * development and is NOT a recovery. Without it, a partial archive is refused.
   */
  allowPartial?: boolean;
  /** Test hook: throw after this file is written. */
  injectAfterWrite?: keyof typeof FILENAMES;
};

/**
 * Materialises an archive into a freshly reserved, empty destination, preserving
 * every logical id, timestamp and array order verbatim. Never merges, never
 * overwrites, never touches live storage. A failure leaves an unmistakably
 * incomplete directory (no completion marker) that a retry refuses.
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

  assertDestinationNotLive(destination, options.liveDataDir ?? JARVIS_DATA_DIR);
  const destDir = await reserveDestination(destination);

  const written: Array<keyof typeof FILENAMES> = [];
  if (archive.groups.core) {
    await writeJson(path.join(destDir, FILENAMES.state), {
      version: 2,
      state: archive.groups.core.state,
      tasks: archive.groups.core.tasks,
      reminders: archive.groups.core.reminders,
    });
    written.push("state");
    if (options.injectAfterWrite === "state") {
      throw new StrictBackupError(
        `Injected failure after writing state; restore left incomplete at ${destDir}.`,
      );
    }
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
    await writeDocuments(destDir, documents, written, options);
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
    await writeDocuments(destDir, documents, written, options);
  }

  // The restored directory is self-describing: the manifest travels with it, so
  // a partial restore cannot later be mistaken for a recovery image.
  await writeJson(path.join(destDir, "manifest.json"), archive.manifest);
  await fsyncDir(destDir);

  await verifyRestoredGroups(destDir, archive);

  const markerPath = path.join(destDir, RESTORE_MARKER);
  await writeJson(markerPath, {
    contractVersion: archive.manifest.contractVersion,
    completeness: archive.manifest.completeness,
    restoredAt: (options.now ?? (() => new Date()))().toISOString(),
    groups: archive.manifest.coverage.present,
    absentGroups: archive.manifest.coverage.absent,
    unresolvedReferences: archive.manifest.unresolvedReferences,
    files: written.map((key) => FILENAMES[key]),
  });
  await fsyncDir(destDir);

  return { destination: destDir, manifest: archive.manifest, markerPath };
}
