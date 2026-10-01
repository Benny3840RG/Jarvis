import { randomUUID } from "node:crypto";
import fs, { type FileHandle } from "node:fs/promises";
import path from "node:path";

function isNodeError(error: unknown): error is NodeJS.ErrnoException {
  return error instanceof Error && "code" in error;
}

async function fsyncDirectory(dir: string): Promise<void> {
  let handle: FileHandle | undefined;
  try {
    handle = await fs.open(dir, "r");
    await handle.sync();
  } catch (error: unknown) {
    if (
      process.platform === "win32" &&
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

/**
 * Atomically publish a JSON document with the same durability and privacy
 * contract as core assistant-state persistence (`jsonPersistence.ts`):
 * exclusive temp create, mode `0o600`, file `fsync` before rename, parent
 * directory `fsync` after rename (including newly created ancestors), and
 * leftover cleanup on failure. Directory sync is best-effort on Windows.
 * A failure after rename leaves the published file in place: the caller must
 * reconcile that result rather than assume nothing was written.
 *
 * Domain JSON stores historically used `open(..., "w")` without an explicit
 * mode or sync. That followed the process umask (typically `0644`) and could
 * leave a truncated file after a crash, exposing invoices, clients, quotes
 * and other business records.
 */
export async function writePrivateJsonFile(filePath: string, value: unknown): Promise<void> {
  const serialized = `${JSON.stringify(value, null, 2)}\n`;
  const destination = path.resolve(filePath);
  const directory = path.dirname(destination);
  const firstCreatedDirectory = await fs.mkdir(directory, { recursive: true });
  const tempPath = path.join(
    directory,
    `.${path.basename(filePath)}.tmp-${process.pid}-${randomUUID()}`,
  );
  let handle: FileHandle | undefined;
  try {
    handle = await fs.open(tempPath, "wx", 0o600);
    await handle.writeFile(serialized, "utf8");
    await handle.sync();
    await handle.close();
    handle = undefined;
    await fs.rename(tempPath, destination);
    // mkdir reports the first new directory. Sync each new entry's parent,
    // bottom-up, through the existing ancestor that now contains that entry.
    const syncThrough =
      firstCreatedDirectory === undefined
        ? directory
        : path.dirname(path.resolve(firstCreatedDirectory));
    let currentDirectory = directory;
    while (true) {
      await fsyncDirectory(currentDirectory);
      if (currentDirectory === syncThrough) break;
      currentDirectory = path.dirname(currentDirectory);
    }
  } catch (error: unknown) {
    await handle?.close().catch(() => undefined);
    await fs.rm(tempPath, { force: true }).catch(() => undefined);
    throw error;
  }
}
