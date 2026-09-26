import { execFileSync } from "node:child_process";
import { loadEnvFile } from "node:process";
import { pathToFileURL } from "node:url";

import {
  probeTemporalEnvironment,
  type TemporalReadiness,
  type TemporalReadinessConnector,
} from "../preview/temporalPass/temporal/environment.js";

export type TemporalReadinessReceipt = TemporalReadiness &
  Readonly<{
    sourceVersion: string;
  }>;

export function validateTemporalSourceVersion(sourceVersion: string): string {
  const normalized = sourceVersion.trim().toLowerCase();
  if (!/^[a-f0-9]{40}$/.test(normalized)) {
    throw new Error("Temporal readiness evidence requires an exact 40-hex source commit SHA.");
  }
  return normalized;
}

export async function runTemporalReadiness(
  environment: NodeJS.ProcessEnv,
  sourceVersion: string,
  connect?: TemporalReadinessConnector,
): Promise<TemporalReadinessReceipt> {
  const exactSourceVersion = validateTemporalSourceVersion(sourceVersion);
  const readiness = await probeTemporalEnvironment(environment, connect);
  return Object.freeze({ sourceVersion: exactSourceVersion, ...readiness });
}

function loadLocalEnvironment(): void {
  try {
    loadEnvFile(".env.local");
  } catch (error: unknown) {
    if (!(error instanceof Error && "code" in error && error.code === "ENOENT")) throw error;
  }
}

async function main(): Promise<void> {
  loadLocalEnvironment();
  const sourceVersion = execFileSync("git", ["rev-parse", "HEAD"], {
    encoding: "utf8",
    stdio: ["ignore", "pipe", "ignore"],
  });
  const receipt = await runTemporalReadiness(process.env, sourceVersion);
  console.log(JSON.stringify(receipt));
  if (!receipt.reachable) process.exitCode = 1;
}

const entryPoint = process.argv[1];
if (entryPoint && import.meta.url === pathToFileURL(entryPoint).href) {
  main().catch((error: unknown) => {
    console.error(error instanceof Error ? error.message : String(error));
    process.exitCode = 1;
  });
}
