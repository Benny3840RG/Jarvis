import { randomUUID } from "node:crypto";
import fs from "node:fs/promises";
import path from "node:path";

import { JsonFileLock } from "../../persistence/jsonFileLock.js";
import { DangerZoneRefusal, nodeErrorCode } from "./errors.js";

function isInside(parent: string, child: string): boolean {
  const relative = path.relative(parent, child);
  return (
    relative !== "" &&
    !relative.startsWith(`..${path.sep}`) &&
    relative !== ".." &&
    !path.isAbsolute(relative)
  );
}

function quarantineDestination(filePath: string, now: Date): string {
  const suffix = `${now.toISOString().replace(/[:.]/g, "-")}-${randomUUID().slice(0, 8)}`;
  return `${filePath}.corrupt-${suffix}`;
}

function refusalForFilesystem(error: unknown, filePath: string): DangerZoneRefusal {
  const code = nodeErrorCode(error);
  if (code === "EACCES" || code === "EPERM") {
    return new DangerZoneRefusal(
      "permission",
      `Cannot quarantine ${filePath}: permission denied (${code}). Check directory permissions and close other local writers.`,
    );
  }
  if (code !== undefined) {
    return new DangerZoneRefusal(
      "permission",
      `Cannot quarantine ${filePath}: filesystem error ${code}.`,
    );
  }
  const message = error instanceof Error ? error.message : "filesystem error";
  if (message.includes("locked by") || message.includes("lock ownership")) {
    return new DangerZoneRefusal("lock", message);
  }
  return new DangerZoneRefusal("permission", `Cannot quarantine ${filePath}: ${message}`);
}

async function assertRegularFileInside(dataDir: string, filePath: string): Promise<boolean> {
  const entry = await fs.lstat(filePath).catch((error: unknown) => {
    if (nodeErrorCode(error) === "ENOENT") return null;
    throw error;
  });
  if (entry === null) return false;
  if (entry.isSymbolicLink()) {
    const target = await fs.realpath(filePath).catch(() => null);
    const outside = target === null || !isInside(dataDir, target);
    throw new DangerZoneRefusal(
      "path",
      outside
        ? `Refusing ${filePath}: symbolic link resolves to ${target ?? "an unknown path"}, outside the Jarvis data directory ${dataDir}.`
        : `Refusing ${filePath}: symbolic link resolves to ${target}. Danger zone will not follow links.`,
    );
  }
  if (!entry.isFile()) {
    throw new DangerZoneRefusal(
      "path",
      `Refusing ${filePath}: Danger zone only quarantines regular files inside ${dataDir}.`,
    );
  }
  const realFile = await fs.realpath(filePath);
  if (!isInside(dataDir, realFile)) {
    throw new DangerZoneRefusal(
      "path",
      `Refusing ${filePath}: it resolves to ${realFile}, outside the Jarvis data directory ${dataDir}.`,
    );
  }
  return true;
}

async function withLocks<T>(
  files: readonly string[],
  lockTimeoutMs: number,
  body: () => Promise<T>,
): Promise<T> {
  const locks = files.map((filePath) => new JsonFileLock(filePath, () => undefined, lockTimeoutMs));
  const runAt = (index: number): Promise<T> => {
    if (index >= locks.length) return body();
    return locks[index].run(() => runAt(index + 1), "danger-zone quarantine");
  };
  try {
    return await runAt(0);
  } catch (error: unknown) {
    if (error instanceof DangerZoneRefusal) throw error;
    throw refusalForFilesystem(error, files[0] ?? "the Jarvis data file");
  }
}

/**
 * Move allowlisted JSON files aside with the same `.corrupt-*` suffix the runtime
 * uses. Holds the existing JSON writer lock and will not follow a symlink.
 * Does not call Convex.
 */
export async function quarantineNamedFiles(options: {
  dataDir: string;
  basenames: readonly string[];
  lockTimeoutMs: number;
  now: () => Date;
}): Promise<string[]> {
  for (const basename of options.basenames) {
    if (basename !== path.basename(basename) || basename.includes("..")) {
      throw new DangerZoneRefusal(
        "path",
        `Refusing ${basename}: Danger zone only quarantines file names inside the Jarvis data directory.`,
      );
    }
  }

  const rootEntry = await fs.lstat(options.dataDir).catch((error: unknown) => {
    if (nodeErrorCode(error) === "ENOENT") return null;
    throw error;
  });
  if (rootEntry === null) return [];
  if (rootEntry.isSymbolicLink()) {
    throw new DangerZoneRefusal(
      "path",
      `Refusing data directory ${options.dataDir}: it is a symbolic link.`,
    );
  }
  if (!rootEntry.isDirectory()) {
    throw new DangerZoneRefusal(
      "path",
      `Refusing data directory ${options.dataDir}: it is not a directory.`,
    );
  }
  const dataDir = await fs.realpath(options.dataDir);
  const files = [...options.basenames]
    .map((basename) => path.join(dataDir, basename))
    .sort((left, right) => (left < right ? -1 : left > right ? 1 : 0));

  return withLocks(files, options.lockTimeoutMs, async () => {
    const present: string[] = [];
    for (const filePath of files) {
      if (await assertRegularFileInside(dataDir, filePath)) present.push(filePath);
    }
    const quarantined: string[] = [];
    for (const filePath of present) {
      const destination = quarantineDestination(filePath, options.now());
      if (!isInside(dataDir, path.resolve(destination))) {
        throw new DangerZoneRefusal(
          "path",
          `Refusing to quarantine ${filePath}: the destination would leave ${dataDir}.`,
        );
      }
      try {
        await fs.rename(filePath, destination);
      } catch (error: unknown) {
        const refusal = refusalForFilesystem(error, filePath);
        if (quarantined.length > 0) {
          throw new DangerZoneRefusal(
            refusal.code,
            `${refusal.message} Already quarantined: ${quarantined.join(", ")}.`,
          );
        }
        throw refusal;
      }
      quarantined.push(destination);
    }
    return quarantined;
  });
}
