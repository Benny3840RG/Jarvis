import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";

import {
  buildArchiveV4,
  readArchiveV4File,
  sealVerifiedArchive,
  writeArchiveV4File,
  type ArchiveV4,
} from "../backup/v4/archive.js";
import { captureJsonGroups, resolveJsonSourceConfig } from "../backup/v4/jsonSource.js";
import { restoreArchiveV4 } from "../backup/v4/restore.js";
import { StrictBackupError } from "../backup/strictValues.js";
import type { ArchiveManifest } from "../backup/archiveManifest.js";

/**
 * Archive v4 CLI surface, kept in its own module so the v1-v3 commands in
 * `runBackup.ts` stay exactly as they were. v4 is additive in every sense: new
 * subcommand names, its own argument shape, and no shared code path with the
 * legacy export/verify/restore flow.
 */

const ARCHIVE_V4_COMMANDS = ["export-v4", "verify-v4", "restore-v4"] as const;

export type ArchiveV4Command = (typeof ARCHIVE_V4_COMMANDS)[number];

export function isArchiveV4Command(value: string): value is ArchiveV4Command {
  return (ARCHIVE_V4_COMMANDS as readonly string[]).includes(value);
}

export function archiveV4Usage(): string[] {
  return [
    "  npm run backup -- export-v4 <file>",
    "  npm run backup -- verify-v4 <file>",
    "  npm run backup -- restore-v4 <file> <empty-destination-dir> [--allow-partial] [--resume]",
    "",
    "Archive v4 is a separate, additive format covering the core, memory and",
    "business-record groups from JSON storage. Notes/evidence, orchestration and",
    "the quote aggregate are not covered yet, so every v4 archive it writes is",
    "coverage: partial — the full-recovery restore path refuses it, and a staged",
    "restore must say --allow-partial to acknowledge it is not a recovery.",
    "",
    "export-v4 proves the archive before writing it: the capture is restored into",
    "a throwaway directory and read back, and the resulting per-group digests are",
    "sealed into the manifest. Coverage, not verification, is what still keeps an",
    "archive partial.",
    "",
    "An interrupted restore leaves the destination unmistakably incomplete. Re-run",
    "with --resume to retain verified output and write missing files; a plain",
    "retry refuses it.",
  ];
}

function describeCoverage(manifest: ArchiveManifest): string {
  const absent = manifest.coverage.absent;
  return (
    `completeness=${manifest.completeness}` +
    ` present=[${manifest.coverage.present.join(", ")}]` +
    (absent.length > 0 ? ` absent=[${absent.join(", ")}]` : "") +
    ` verified=[${(manifest.verification?.groups ?? []).map((entry) => entry.group).join(", ")}]`
  );
}

/**
 * Printed after every command, never as a warning suffix that scrolls away: a
 * broken edge in the source is something the operator has to see, even though it
 * is not a reason to refuse the capture.
 */
function reportUnresolvedReferences(manifest: ArchiveManifest): void {
  const unresolved = manifest.unresolvedReferences;
  if (unresolved.length === 0) return;
  console.log(
    `${String(unresolved.length)} reference(s) in the source do not resolve. They are captured as-is, not repaired:`,
  );
  for (const entry of unresolved) {
    console.log(
      `  ${entry.collection}/${entry.recordId}.${entry.field} -> ${entry.targetCollection}/${entry.value} (missing)`,
    );
  }
}

function describeCounts(archive: ArchiveV4): string {
  return archive.manifest.groups
    .map(
      (entry) =>
        `${entry.group}{${Object.entries(entry.counts)
          .map(([domain, count]) => `${domain}=${String(count)}`)
          .join(", ")}}`,
    )
    .join(" ");
}

/**
 * Runs the archive through a full restore in a throwaway directory and returns
 * it sealed with the evidence that pass produced. Live storage is never read or
 * written, and the directory is removed whether or not verification passed.
 *
 * Sealing after the fact is sound because the evidence attests to the group
 * payloads, which the seal does not touch — it only adds the record to the
 * manifest that wraps them.
 */
async function sealByIsolatedRestore(archive: ArchiveV4): Promise<ArchiveV4> {
  const scratch = await mkdtemp(path.join(tmpdir(), "jarvis-archive-v4-seal-"));
  try {
    const result = await restoreArchiveV4(archive, path.join(scratch, "restore"), {
      // The archive is genuinely unverified at this moment — that is what this
      // restore is about to establish — so it is materialised as the partial
      // archive it still is.
      allowPartial: true,
    });
    return sealVerifiedArchive(archive, result.verifiedGroups, new Date());
  } finally {
    await rm(scratch, { recursive: true, force: true });
  }
}

async function exportArchive(filePath: string): Promise<void> {
  const paths = resolveJsonSourceConfig();
  const capture = await captureJsonGroups(paths);
  // Written only after it has been proven to restore, so an archive on disk has
  // always survived a real read-back rather than merely having been serialised.
  const archive = await sealByIsolatedRestore(buildArchiveV4(capture, new Date()));
  await writeArchiveV4File(filePath, archive);
  console.log(
    `Archive v4 written: ${filePath} — ${describeCoverage(archive.manifest)}; ${describeCounts(archive)}.`,
  );
  reportUnresolvedReferences(archive.manifest);
}

/**
 * Proves the archive restores, by materialising it into a throwaway directory
 * and running the same two-way verification a real restore runs. The temporary
 * directory is removed whether or not verification passed; live storage is never
 * read or written.
 */
async function verifyArchive(filePath: string): Promise<void> {
  const archive = await readArchiveV4File(filePath);
  const scratch = await mkdtemp(path.join(tmpdir(), "jarvis-archive-v4-verify-"));
  try {
    await restoreArchiveV4(archive, path.join(scratch, "restore"), {
      // A complete archive goes through the real recovery gate, so verifying one
      // exercises the same refusal a genuine recovery would face. Only an archive
      // that is still partial is materialised under the staged-development flag.
      allowPartial: archive.manifest.completeness === "partial",
    });
  } finally {
    await rm(scratch, { recursive: true, force: true });
  }
  console.log(
    `Archive v4 verified in isolated storage: ${filePath} — ${describeCoverage(archive.manifest)}; ${describeCounts(archive)}.`,
  );
  reportUnresolvedReferences(archive.manifest);
}

async function restoreArchive(
  filePath: string,
  destination: string,
  allowPartial: boolean,
  resume: boolean,
): Promise<void> {
  const archive = await readArchiveV4File(filePath);
  if (archive.manifest.completeness === "partial" && !allowPartial) {
    throw new StrictBackupError(
      `Archive ${filePath} is partial (absent: ${archive.manifest.coverage.absent.join(", ")}). ` +
        "The full-recovery path refuses a partial archive. Re-run with --allow-partial only if you " +
        "intend a staged development restore, which is not a recovery.",
    );
  }
  const result = await restoreArchiveV4(archive, destination, { allowPartial, resume });
  console.log(
    `Archive v4 ${result.resumed ? "restore resumed and completed" : "restored"} into ${result.destination} — ${describeCoverage(result.manifest)}; ${describeCounts(archive)}.`,
  );
  console.log(`Completion marker: ${result.markerPath}`);
  reportUnresolvedReferences(result.manifest);
  if (result.manifest.completeness === "partial") {
    console.log(
      "This restore is NOT a recovery: the archive was partial and was materialised under --allow-partial.",
    );
  }
}

export async function runArchiveV4Command(
  command: ArchiveV4Command,
  args: readonly string[],
  usage: () => never,
): Promise<void> {
  if (command === "export-v4" || command === "verify-v4") {
    const [filePath, ...extra] = args;
    if (!filePath || extra.length > 0) usage();
    if (command === "export-v4") await exportArchive(filePath);
    else await verifyArchive(filePath);
    return;
  }

  const [filePath, destination, ...flags] = args;
  if (!filePath || !destination) usage();
  const known = new Set(["--allow-partial", "--resume"]);
  if (flags.some((flag) => !known.has(flag)) || new Set(flags).size !== flags.length) usage();
  await restoreArchive(
    filePath,
    destination,
    flags.includes("--allow-partial"),
    flags.includes("--resume"),
  );
}
