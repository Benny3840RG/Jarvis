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
 * directory `fsync` after rename, and leftover cleanup on failure.
 *
 * Domain JSON stores historically used `open(..., "w")` without an explicit
 * mode or sync. That followed the process umask (typically `0644`) and could
 * leave a truncated file after a crash, exposing invoices, clients, quotes
 * and other business records.
 */
export async function writePrivateJsonFile(filePath: string, value: unknown): Promise<void> {
  const serialized = `${JSON.stringify(value, null, 2)}\n`;
  const directory = path.dirname(filePath);
  await fs.mkdir(directory, { recursive: true });
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
    await fs.rename(tempPath, filePath);
    await fsyncDirectory(directory);
  } catch (error: unknown) {
    await handle?.close().catch(() => undefined);
    await fs.rm(tempPath, { force: true }).catch(() => undefined);
    throw error;
  }
}
