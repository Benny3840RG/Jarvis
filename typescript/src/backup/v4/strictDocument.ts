import fs, { constants as fsConstants, type FileHandle } from "node:fs/promises";

import { assertUniqueIds } from "../backup.js";
import {
  assertArray,
  assertNoUnknownKeys,
  assertRecord,
  StrictBackupError,
} from "../strictValues.js";
import { overLimitAdvice, resolveMaxArchiveBytes } from "./limits.js";

/**
 * The strict document readers every archive v4 JSON source goes through.
 *
 * Kept separate from the group readers so `jsonSource.ts` and
 * `businessSource.ts` can share them without importing each other, and so there
 * is exactly one place where "how a v4 source file is opened and parsed" is
 * defined: symlinks refused, non-regular files refused, malformed JSON aborting
 * rather than being quarantined, and a never-created file — and only that —
 * reported as absent.
 */

function isNodeError(error: unknown): error is NodeJS.ErrnoException {
  return error instanceof Error && "code" in error;
}

/** Reads and parses one covered file. `null` means the file has never existed. */
export async function readRawJson(filePath: string): Promise<unknown | null> {
  const linkStat = await fs.lstat(filePath).catch((error: unknown) => {
    if (isNodeError(error) && error.code === "ENOENT") return null;
    throw new StrictBackupError(
      `Backup source ${filePath} could not be inspected: ${
        error instanceof Error ? error.message : String(error)
      }`,
    );
  });
  if (linkStat === null) return null;
  if (linkStat.isSymbolicLink()) {
    throw new StrictBackupError(
      `Backup source ${filePath} is a symbolic link; refusing to follow it.`,
    );
  }

  let handle: FileHandle | undefined;
  let raw: string;
  try {
    handle = await fs.open(filePath, fsConstants.O_RDONLY | (fsConstants.O_NOFOLLOW ?? 0));
    const stat = await handle.stat();
    if (!stat.isFile())
      throw new StrictBackupError(`Backup source ${filePath} is not a regular file.`);
    // Bounded on the same limit the archive is bounded on: reading a source the
    // archive could never hold, only to fail at write time, wastes the whole
    // capture and pulls an unbounded file into memory on the way.
    const limit = resolveMaxArchiveBytes();
    if (stat.size > limit) {
      throw new StrictBackupError(
        `Backup source ${filePath} is ${String(stat.size)} bytes. ${overLimitAdvice(limit)}`,
      );
    }
    raw = await handle.readFile("utf8");
  } catch (error: unknown) {
    if (error instanceof StrictBackupError) throw error;
    if (isNodeError(error) && error.code === "ENOENT") return null;
    throw new StrictBackupError(
      `Backup source ${filePath} could not be read: ${
        error instanceof Error ? error.message : String(error)
      }`,
    );
  } finally {
    await handle?.close().catch(() => undefined);
  }

  try {
    return JSON.parse(raw) as unknown;
  } catch (error: unknown) {
    throw new StrictBackupError(
      `Backup source ${filePath} is not valid JSON: ${
        error instanceof Error ? error.message : String(error)
      }`,
    );
  }
}

export function assertDocumentVersion(
  document: Record<string, unknown>,
  expected: number,
  filePath: string,
): void {
  if (!("version" in document)) {
    throw new StrictBackupError(`Backup source ${filePath} is missing its document version.`);
  }
  if (document.version !== expected) {
    throw new StrictBackupError(
      `Backup source ${filePath} has unsupported document version ${String(document.version)} (expected ${expected}).`,
    );
  }
}

export function parseRows<T extends { id: string }>(
  rows: unknown,
  filePath: string,
  arrayKey: string,
  allowed: readonly string[],
  parse: (value: unknown, index: number) => T,
  noun: string,
): T[] {
  const array = assertArray(rows, `${filePath} "${arrayKey}"`);
  const records = array.map((row, index) => {
    const record = assertRecord(row, `${filePath} ${arrayKey}[${index}]`);
    assertNoUnknownKeys(record, allowed, `${filePath} ${arrayKey}[${index}]`);
    return parse(row, index);
  });
  assertUniqueIds(records, noun);
  return records;
}

export async function readArrayDocument<T extends { id: string }>(
  filePath: string,
  arrayKey: string,
  version: number,
  allowed: readonly string[],
  parse: (value: unknown, index: number) => T,
  noun: string,
): Promise<T[]> {
  const raw = await readRawJson(filePath);
  if (raw === null) return [];
  const document = assertRecord(raw, `Backup source ${filePath}`);
  assertDocumentVersion(document, version, filePath);
  assertNoUnknownKeys(document, ["version", arrayKey], `Backup source ${filePath}`);
  if (!(arrayKey in document)) {
    throw new StrictBackupError(`Backup source ${filePath} is missing its "${arrayKey}" array.`);
  }
  return parseRows(document[arrayKey], filePath, arrayKey, allowed, parse, noun);
}

/**
 * Raw strict read of one document: the parsed object, or `null` when the file
 * has never existed. Shared with the business-record readers so every v4 source
 * goes through the same symlink refusal, regular-file check and
 * abort-on-malformed-JSON behaviour.
 */
export async function readStrictDocument(
  filePath: string,
): Promise<Record<string, unknown> | null> {
  const raw = await readRawJson(filePath);
  if (raw === null) return null;
  return assertRecord(raw, `Backup source ${filePath}`);
}

/**
 * Strict read of a `{ version, <collection>: [...] }` document. Closed schema at
 * both levels: an unknown top-level field, a wrong version, a missing array or a
 * duplicate id all abort rather than being tolerated.
 */
export async function readStrictArrayDocument<T extends { id: string }>(
  filePath: string,
  arrayKey: string,
  version: number,
  parse: (value: unknown, at: string) => T,
  noun: string,
): Promise<T[]> {
  const document = await readStrictDocument(filePath);
  if (document === null) return [];
  assertDocumentVersion(document, version, filePath);
  assertNoUnknownKeys(document, ["version", arrayKey], `Backup source ${filePath}`);
  if (!(arrayKey in document)) {
    throw new StrictBackupError(`Backup source ${filePath} is missing its "${arrayKey}" array.`);
  }
  const rows = assertArray(document[arrayKey], `${filePath} "${arrayKey}"`);
  const records = rows.map((row, index) => parse(row, `${filePath} ${arrayKey}[${index}]`));
  assertUniqueIds(records, noun);
  return records;
}
