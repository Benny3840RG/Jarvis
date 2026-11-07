import { execFileSync } from "node:child_process";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { loadEnvFile } from "node:process";
import { fileURLToPath, pathToFileURL } from "node:url";

import {
  LOCAL_V1_RECOVERY_MANUAL_STEPS,
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
 * (Stage 8 / LV1-09), writes a dated evidence file, and prints a result table.
 * Exits non-zero on any failure. Evidence, not acceptance — it clears no gate.
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

function configFromEnvironment(
  environment: NodeJS.ProcessEnv,
  sha: string,
): LocalV1RestartProofConfig {
  return {
    isolatedConvexUrl: required(environment, "JARVIS_LV1_ISOLATED_CONVEX_URL"),
    configuredConvexUrl: environment.CONVEX_URL?.trim(),
    deliveryRuntimeToken: required(environment, "JARVIS_DELIVERY_RUNTIME_TOKEN"),
    jsonDirectory: required(environment, "JARVIS_LV1_JSON_DIR"),
    liveDirectory: environment.JARVIS_LV1_LIVE_DIR?.trim() ?? JARVIS_DATA_DIR,
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

async function main(): Promise<void> {
  loadLocalEnvironment();
  const sha = sourceSha();
  const config = configFromEnvironment(process.env, sha);
  const record = await runLocalV1RestartProof(config);
  const evidence = renderLocalV1RestartProofEvidence(record);
  const outPath = evidencePath(process.env, sha);
  await fs.mkdir(path.dirname(outPath), { recursive: true });
  await fs.writeFile(outPath, `${evidence}\n`, "utf8");

  console.log(evidence);
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
