import { randomUUID } from "node:crypto";
import { spawn } from "node:child_process";
import fs, { type FileHandle } from "node:fs/promises";
import path from "node:path";

import { OVERLAP_PREVIOUS_ENV } from "./confirm.js";
import { DangerZoneRefusal, nodeErrorCode } from "./errors.js";

const ALLOWED_REMOVALS = new Set<string>(Object.values(OVERLAP_PREVIOUS_ENV));

export type CommandResult = {
  code: number | null;
};

export type CommandRunner = (
  command: string,
  args: readonly string[],
  cwd: string,
) => Promise<CommandResult>;

/**
 * Run `npx convex env remove <PREVIOUS>` without a shell and without keeping
 * CLI output. Stderr is discarded so a token printed by the CLI cannot reach
 * the operator response.
 */
export function spawnConvexCommand(
  command: string,
  args: readonly string[],
  cwd: string,
): Promise<CommandResult> {
  return new Promise((resolve, reject) => {
    const child = spawn(command, [...args], {
      cwd,
      shell: false,
      stdio: ["ignore", "ignore", "ignore"],
    });
    child.on("error", reject);
    child.on("close", (code) => resolve({ code }));
  });
}

export async function removeConvexPreviousEnv(
  variableName: string,
  options: { cwd: string; run: CommandRunner },
): Promise<void> {
  if (!ALLOWED_REMOVALS.has(variableName)) {
    throw new DangerZoneRefusal(
      "overlap-unchanged",
      "Refusing to remove an environment variable that is not a Jarvis previous-token overlap. Overlap was left in place.",
    );
  }
  let result: CommandResult;
  try {
    result = await options.run("npx", ["convex", "env", "remove", variableName], options.cwd);
  } catch (error: unknown) {
    if (nodeErrorCode(error) === "ENOENT") {
      throw new DangerZoneRefusal(
        "overlap-unchanged",
        `The Convex CLI is not available. Overlap was left in place. Run: npx convex env remove ${variableName}`,
      );
    }
    throw new DangerZoneRefusal(
      "overlap-unchanged",
      `Convex env remove could not be started for ${variableName}. Overlap was left in place.`,
    );
  }
  if (result.code !== 0) {
    throw new DangerZoneRefusal(
      "overlap-unchanged",
      `Convex env remove failed for ${variableName} (exit ${String(result.code)}). Overlap was left in place.`,
    );
  }
}

function assignmentKey(line: string): string | null {
  const match = /^([A-Za-z_][A-Za-z0-9_]*)=/.exec(line);
  return match?.[1] ?? null;
}

/** Drop one KEY= line from a local env file. The value is never returned. */
export async function removeLocalEnvAssignment(
  filePath: string,
  key: string,
): Promise<"removed" | "absent" | "missing-file"> {
  if (!ALLOWED_REMOVALS.has(key)) {
    throw new DangerZoneRefusal(
      "overlap-unchanged",
      "Refusing to edit a local env entry that is not a Jarvis previous-token overlap.",
    );
  }
  let raw: string;
  try {
    raw = await fs.readFile(filePath, "utf8");
  } catch (error: unknown) {
    if (nodeErrorCode(error) === "ENOENT") return "missing-file";
    const code = nodeErrorCode(error) ?? "error";
    throw new DangerZoneRefusal(
      "permission",
      `Cannot read the local env file ${filePath} (${code}).`,
    );
  }
  const trailingNewline = raw.endsWith("\n");
  const lines = raw.split("\n");
  let removed = false;
  const kept = lines.filter((line) => {
    if (assignmentKey(line) !== key) return true;
    removed = true;
    return false;
  });
  if (!removed) return "absent";
  let next = kept.join("\n");
  if (trailingNewline && !next.endsWith("\n")) next = `${next}\n`;
  if (next === "\n") next = "";
  try {
    await writePrivateText(filePath, next);
  } catch (error: unknown) {
    const code = nodeErrorCode(error) ?? "error";
    throw new DangerZoneRefusal(
      "permission",
      `Cannot update the local env file ${filePath} (${code}).`,
    );
  }
  return "removed";
}

async function writePrivateText(filePath: string, contents: string): Promise<void> {
  await fs.mkdir(path.dirname(filePath), { recursive: true });
  const tempPath = path.join(
    path.dirname(filePath),
    `.${path.basename(filePath)}.tmp-${process.pid}-${randomUUID()}`,
  );
  let handle: FileHandle | undefined;
  try {
    handle = await fs.open(tempPath, "wx", 0o600);
    await handle.writeFile(contents, "utf8");
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
