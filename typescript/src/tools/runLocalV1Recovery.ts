import { execFileSync } from "node:child_process";
import { constants, type BigIntStats } from "node:fs";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { loadEnvFile } from "node:process";
import { fileURLToPath, pathToFileURL } from "node:url";

import {
  LOCAL_V1_RECOVERY_MANUAL_STEPS,
  canonicalRecoveryPath,
  localV1RestartProofPassed,
  renderLocalV1RestartProofEvidence,
  runLocalV1RestartProof,
  type LocalV1RestartProofConfig,
} from "../backup/v4/localV1RecoveryDriver.js";
import { JARVIS_DATA_DIR } from "../persistence/jarvisDataPaths.js";
import { redactSecret } from "./convexSmoke.js";

/**
 * `npm run commission:local-v1-recovery`
 *
 * Runs the host restart proof on an isolated self-hosted convex-local-backend
 * (Stage 8 / LV1-09), writes an evidence file named for the source SHA, and
 * prints a result table. The evidence writer is Linux-only: it needs
 * /proc/self/fd to pin each output directory. The output path is checked
 * before the proof runs, so a bad path fails before any process is started.
 * Exits non-zero on any failure. Evidence, not acceptance — it clears no gate.
 * An absent optional CONVEX_URL is recorded as N/A, never as a passed refusal.
 * Evidence must be outside live/restored JSON data and use a new file path;
 * existing output files are never overwritten.
 *
 * It automates only the restart-proof slice. The capture, isolated restore,
 * reread, and Convex-function rollback assertions remain the operator's steps
 * (printed below and recorded unchecked in the evidence file), because they
 * depend on post-restore id remapping that resolves only against the live
 * isolated backend.
 *
 * Required environment (an isolated backend must already be running):
 *   JARVIS_LV1_ISOLATED_CONVEX_URL   loopback convex-local-backend, e.g. http://127.0.0.1:3210
 *   JARVIS_DELIVERY_RUNTIME_TOKEN    delivery runtime token for the isolated child
 *   JARVIS_LV1_JSON_DIR              restored JSON directory from the isolated restore
 *   JARVIS_LV1_CLIENT_ID             representative restored client id
 *   JARVIS_LV1_TASK_ID               representative restored task id (Convex physical id)
 *   JARVIS_LV1_BUILD_ID              representative restored build id (Convex physical id)
 *   JARVIS_LV1_QUOTE_ID              representative restored quote id
 * Optional:
 *   CONVEX_URL                       the configured deployment, refused as a target
 *   JARVIS_SERVICE_TOKEN             overrides the restart harness service token
 *   JARVIS_LV1_LIVE_DIR              live data directory (default: JARVIS_DATA_DIR)
 *   JARVIS_LV1_EVIDENCE_FILE         evidence output path (default: ~/lv1-01/restart-proof-<sha>.md)
 */

function loadLocalEnvironment(): void {
  try {
    loadEnvFile(".env.local");
  } catch (error: unknown) {
    if (!(error instanceof Error && "code" in error && error.code === "ENOENT")) throw error;
  }
}

function required(environment: NodeJS.ProcessEnv, key: string): string {
  const value = environment[key]?.trim();
  if (value === undefined || value.length === 0) {
    throw new Error(`commission:local-v1-recovery requires ${key} in the environment.`);
  }
  return value;
}

function repositoryRoot(): string {
  return fileURLToPath(new URL("../../..", import.meta.url));
}

function sourceSha(): string {
  const root = repositoryRoot();
  const sha = execFileSync("git", ["rev-parse", "HEAD"], {
    cwd: root,
    encoding: "utf8",
    stdio: ["ignore", "pipe", "ignore"],
  }).trim();
  if (!/^[a-f0-9]{40}$/.test(sha)) {
    throw new Error("commission:local-v1-recovery could not read the source commit SHA.");
  }
  const dirty = execFileSync("git", ["status", "--porcelain", "--untracked-files=normal"], {
    cwd: root,
    encoding: "utf8",
    stdio: ["ignore", "pipe", "ignore"],
  }).trim();
  if (dirty) {
    throw new Error("commission:local-v1-recovery requires a clean committed working tree.");
  }
  return sha;
}

export function configFromEnvironment(
  environment: NodeJS.ProcessEnv,
  sha: string,
): LocalV1RestartProofConfig {
  return {
    isolatedConvexUrl: required(environment, "JARVIS_LV1_ISOLATED_CONVEX_URL"),
    configuredConvexUrl: environment.CONVEX_URL?.trim(),
    deliveryRuntimeToken: required(environment, "JARVIS_DELIVERY_RUNTIME_TOKEN"),
    jsonDirectory: required(environment, "JARVIS_LV1_JSON_DIR"),
    liveDirectory: path.resolve(
      environment.JARVIS_LV1_LIVE_DIR?.trim() ||
        environment.JARVIS_DATA_DIR?.trim() ||
        JARVIS_DATA_DIR,
    ),
    ids: {
      clientId: required(environment, "JARVIS_LV1_CLIENT_ID"),
      taskId: required(environment, "JARVIS_LV1_TASK_ID"),
      buildId: required(environment, "JARVIS_LV1_BUILD_ID"),
      quoteId: required(environment, "JARVIS_LV1_QUOTE_ID"),
    },
    sourceSha: sha,
    ...(environment.JARVIS_SERVICE_TOKEN?.trim()
      ? { serviceToken: environment.JARVIS_SERVICE_TOKEN.trim() }
      : {}),
  };
}

function evidencePath(environment: NodeJS.ProcessEnv, sha: string): string {
  const configured = environment.JARVIS_LV1_EVIDENCE_FILE?.trim();
  if (configured !== undefined && configured.length > 0) return path.resolve(configured);
  return path.join(os.homedir(), "lv1-01", `restart-proof-${sha}.md`);
}

// Opens a directory for path traversal only, so a search-only ancestor (for
// example a 0711 /home) does not need to be readable. Not in fs.constants.
const O_PATH = 0o10000000;
const DIRECTORY_FLAGS = O_PATH | constants.O_DIRECTORY;

/**
 * Checks everything about the evidence path that can be known before the
 * proof runs, and returns the canonical target. The write repeats the
 * containment checks; this only moves avoidable failures ahead of the proof.
 */
export async function assertRecoveryEvidencePath(
  outPath: string,
  config: LocalV1RestartProofConfig,
): Promise<string> {
  const target = await canonicalRecoveryPath(outPath);
  for (const directory of [config.liveDirectory, config.jsonDirectory]) {
    const protectedRoot = await canonicalRecoveryPath(directory);
    const relative = path.relative(protectedRoot, target);
    if (
      relative === "" ||
      (!relative.startsWith(`..${path.sep}`) && relative !== ".." && !path.isAbsolute(relative))
    ) {
      throw new Error("Recovery evidence output must be outside every protected data directory.");
    }
  }
  // Node has no openat API. On Linux, /proc/self/fd lets each child be opened
  // relative to a pinned parent; O_NOFOLLOW rejects a swapped-in symlink.
  if (process.platform !== "linux") {
    throw new Error("Recovery evidence output requires Linux directory-handle containment.");
  }
  try {
    await fs.lstat(target);
  } catch (error: unknown) {
    if (error instanceof Error && "code" in error && error.code === "ENOENT") return target;
    throw error;
  }
  throw new Error("Recovery evidence output already exists; existing files are never replaced.");
}

export async function writeRecoveryEvidence(
  outPath: string,
  evidence: string,
  config: LocalV1RestartProofConfig,
): Promise<void> {
  // Keep the protected inodes open before pathname validation. A rename can
  // otherwise move a protected directory into the output tree during traversal.
  const protectedDirectories: fs.FileHandle[] = [];
  try {
    for (const protectedPath of [config.liveDirectory, config.jsonDirectory]) {
      const canonical = await canonicalRecoveryPath(protectedPath);
      const intended = await fs.stat(canonical, { bigint: true });
      const handle = await fs.open(canonical, DIRECTORY_FLAGS | constants.O_NOFOLLOW);
      protectedDirectories.push(handle);
      const [opened, current] = await Promise.all([
        handle.stat({ bigint: true }),
        fs.stat(protectedPath, { bigint: true }),
      ]);
      if (
        !opened.isDirectory() ||
        intended.dev !== opened.dev ||
        intended.ino !== opened.ino ||
        current.dev !== opened.dev ||
        current.ino !== opened.ino
      ) {
        throw new Error("Recovery evidence protected data directory changed before creation.");
      }
    }
    const protectedIds = await Promise.all(
      protectedDirectories.map((handle) => handle.stat({ bigint: true })),
    );
    const assertUnprotected = async (handle: fs.FileHandle): Promise<void> => {
      const opened = await handle.stat({ bigint: true });
      if (protectedIds.some((root) => root.dev === opened.dev && root.ino === opened.ino)) {
        throw new Error("Recovery evidence output must be outside every protected data directory.");
      }
    };

    // Root identity alone misses a directory that sits below a protected
    // root, for example an output parent renamed into the live tree after it
    // was opened. Walk ".." from the pinned handle and refuse any protected
    // ancestor.
    const assertNoProtectedAncestor = async (handle: fs.FileHandle): Promise<void> => {
      let current = handle;
      try {
        for (let depth = 0; depth < 4096; depth += 1) {
          await assertUnprotected(current);
          // Built by hand: path.join would fold the ".." away.
          const above = await fs.open(`/proc/self/fd/${current.fd}/..`, DIRECTORY_FLAGS);
          let here: BigIntStats;
          let up: BigIntStats;
          try {
            [here, up] = await Promise.all([
              current.stat({ bigint: true }),
              above.stat({ bigint: true }),
            ]);
          } catch (error: unknown) {
            await above.close();
            throw error;
          }
          if (current !== handle) await current.close();
          current = above;
          if (here.dev === up.dev && here.ino === up.ino) return;
        }
        throw new Error("Recovery evidence output parent is nested too deeply to verify.");
      } finally {
        if (current !== handle) await current.close();
      }
    };

    const target = await assertRecoveryEvidencePath(outPath, config);
    const parent = path.dirname(target);
    let directory = await fs.open(path.parse(parent).root, DIRECTORY_FLAGS | constants.O_NOFOLLOW);
    // Directories this call created, with the pinned parent each was made in.
    // If the write is refused they are removed again, deepest first, so a
    // refusal leaves nothing behind even if a parent was moved under protected
    // data in the meantime.
    const createdDirectories: {
      parent: fs.FileHandle;
      name: string;
      dev: bigint;
      ino: bigint;
    }[] = [];
    const removeCreatedDirectories = async (reason: unknown): Promise<never> => {
      try {
        for (const made of [...createdDirectories].reverse()) {
          const entry = path.join("/proc/self/fd", String(made.parent.fd), made.name);
          const current = await fs.lstat(entry, { bigint: true });
          if (current.dev !== made.dev || current.ino !== made.ino) {
            throw new Error("A directory created for the evidence file was replaced.");
          }
          await fs.rmdir(entry);
        }
      } catch (cleanup: unknown) {
        const text = reason instanceof Error ? reason.message : String(reason);
        throw new Error(
          `Recovery evidence directories could not be removed after a failure: ${text}`,
          { cause: cleanup },
        );
      }
      throw reason;
    };
    try {
      await assertUnprotected(directory);
      for (const component of parent.split(path.sep).filter(Boolean)) {
        const child = path.join("/proc/self/fd", String(directory.fd), component);
        let next: fs.FileHandle;
        let made = false;
        try {
          next = await fs.open(child, DIRECTORY_FLAGS | constants.O_NOFOLLOW);
        } catch (error: unknown) {
          if (!(error instanceof Error && "code" in error && error.code === "ENOENT")) throw error;
          await assertNoProtectedAncestor(directory);
          await fs.mkdir(child, { mode: 0o700 });
          made = true;
          next = await fs.open(child, DIRECTORY_FLAGS | constants.O_NOFOLLOW);
        }
        try {
          if (made) {
            const stat = await next.stat({ bigint: true });
            createdDirectories.push({
              parent: directory,
              name: component,
              dev: stat.dev,
              ino: stat.ino,
            });
            await assertNoProtectedAncestor(next);
          } else {
            await assertUnprotected(next);
          }
        } catch (error: unknown) {
          await next.close();
          throw error;
        }
        // A parent that had a directory created in it stays open for rollback.
        if (!made) await directory.close();
        directory = next;
      }
      await assertNoProtectedAncestor(directory);
      // Never truncate an existing archive, evidence file, symlink or hardlink.
      const created = path.join("/proc/self/fd", String(directory.fd), path.basename(target));
      const file = await fs.open(
        created,
        constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW,
        0o600,
      );
      // Checked while the file is still empty, and again after the write. The
      // writer cannot detect a rename that happens after the last check, so
      // the evidence parent must not be relocated while the proof runs.
      const assertParentInPlace = async (): Promise<void> => {
        await assertNoProtectedAncestor(directory);
        const [expected, actual] = await Promise.all([directory.stat(), fs.lstat(parent)]);
        if (!actual.isDirectory() || expected.dev !== actual.dev || expected.ino !== actual.ino) {
          throw new Error("Recovery evidence output parent changed during creation.");
        }
      };
      // Any failure after creation removes the file, but only if the entry at
      // that name is still the inode this writer created. Anything else is left
      // alone and reported.
      const removeCreated = async (reason: unknown): Promise<never> => {
        try {
          const [mine, entry] = await Promise.all([
            file.stat({ bigint: true }),
            fs.lstat(created, { bigint: true }),
          ]);
          if (mine.dev !== entry.dev || mine.ino !== entry.ino) {
            throw new Error("The evidence path no longer names the file this writer created.");
          }
          await fs.unlink(created);
        } catch (cleanup: unknown) {
          const text = reason instanceof Error ? reason.message : String(reason);
          throw new Error(`Recovery evidence file could not be removed after a failure: ${text}`, {
            cause: cleanup,
          });
        }
        throw reason;
      };
      try {
        await assertParentInPlace();
        await file.writeFile(`${evidence}\n`, { encoding: "utf8" });
        await assertParentInPlace();
      } catch (error: unknown) {
        await removeCreated(error);
      } finally {
        await file.close();
      }
    } catch (error: unknown) {
      await removeCreatedDirectories(error);
    } finally {
      const open = new Set([directory, ...createdDirectories.map((made) => made.parent)]);
      await Promise.all([...open].map((handle) => handle.close()));
    }
  } finally {
    await Promise.all(protectedDirectories.map((handle) => handle.close()));
  }
}

async function main(): Promise<void> {
  loadLocalEnvironment();
  const sha = sourceSha();
  const config = configFromEnvironment(process.env, sha);
  const outPath = evidencePath(process.env, sha);
  await assertRecoveryEvidencePath(outPath, config);
  const record = await runLocalV1RestartProof(config);
  const evidence = renderLocalV1RestartProofEvidence(record);
  console.log(evidence);
  await writeRecoveryEvidence(outPath, evidence, config);
  console.log("");
  console.log(`Evidence written to ${outPath}`);
  console.log("");
  console.log("Operator steps this driver does not perform:");
  for (const step of LOCAL_V1_RECOVERY_MANUAL_STEPS) {
    console.log(`  - ${step}`);
  }
  if (!localV1RestartProofPassed(record)) {
    console.error("\nRestart proof FAILED: at least one check did not pass.");
    process.exitCode = 1;
  }
}

const entryPoint = process.argv[1];
if (entryPoint && import.meta.url === pathToFileURL(entryPoint).href) {
  main().catch((error: unknown) => {
    console.error(
      "commission:local-v1-recovery failed:",
      redactSecret(
        error,
        process.env.JARVIS_DELIVERY_RUNTIME_TOKEN,
        process.env.JARVIS_SERVICE_TOKEN,
      ),
    );
    process.exitCode = 1;
  });
}
