import { randomUUID } from "node:crypto";
import fs, { type FileHandle } from "node:fs/promises";
import path from "node:path";

/**
 * Atomically publish a JSON document with the same durability and privacy
 * contract as core assistant-state persistence (`jsonPersistence.ts`):
 * exclusive temp create, mode `0o600`, `fsync` before rename, and leftover
 * cleanup on failure.
 *
 * Domain JSON stores historically used `open(..., "w")` without an explicit
 * mode or sync. That followed the process umask (typically `0644`) and could
 * leave a truncated file after a crash, exposing invoices, clients, quotes
 * and other business records.
 */
export async function writePrivateJsonFile(filePath: string, value: unknown): Promise<void> {
  const serialized = `${JSON.stringify(value, null, 2)}\n`;
  await fs.mkdir(path.dirname(filePath), { recursive: true });
  const tempPath = path.join(
    path.dirname(filePath),
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
  } catch (error: unknown) {
    await handle?.close().catch(() => undefined);
    await fs.rm(tempPath, { force: true }).catch(() => undefined);
    throw error;
  }
}
