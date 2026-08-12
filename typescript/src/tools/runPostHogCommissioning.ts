import { pathToFileURL } from "node:url";
import { loadEnvFile } from "node:process";
import { execFileSync } from "node:child_process";

import type { NestFastifyApplication } from "@nestjs/platform-fastify";

import { createJarvisHttpApp } from "../http/app.js";
import { createPostHogTelemetryFromEnv, type PostHogTelemetry } from "../observability/posthog.js";
import { applyPreviewEnvironment } from "../preview/environment.js";

type HttpAppFactory = () => Promise<NestFastifyApplication>;
type SourceVersionEnvironment = { readonly JARVIS_SOURCE_VERSION?: string };

export type PostHogCommissioningReceipt = {
  statusCode: number;
  telemetryFlushed: true;
};

export function resolveCommissioningSourceVersion(
  environment: SourceVersionEnvironment = process.env,
  readGitHead: () => string = () =>
    execFileSync("git", ["rev-parse", "HEAD"], {
      encoding: "utf8",
      stdio: ["ignore", "pipe", "ignore"],
    }),
): string {
  return environment.JARVIS_SOURCE_VERSION?.trim() || readGitHead().trim();
}

function loadLocalEnvironment(): void {
  try {
    loadEnvFile(".env.local");
  } catch (error: unknown) {
    if (!(error instanceof Error && "code" in error && error.code === "ENOENT")) throw error;
  }
}

export async function runPostHogCommissioning(
  telemetry: PostHogTelemetry,
  createApp: HttpAppFactory = () => createJarvisHttpApp({ telemetry, logger: false }),
): Promise<PostHogCommissioningReceipt> {
  if (!telemetry.enabled) {
    throw new Error(
      "PostHog telemetry is not enabled. Set the development-only PostHog environment before commissioning.",
    );
  }

  const app = await createApp();
  let statusCode: number;
  try {
    const response = await app.inject({ method: "GET", url: "/healthz" });
    statusCode = response.statusCode;
    if (statusCode !== 200) {
      throw new Error(`Jarvis commissioning health boundary returned HTTP ${statusCode}.`);
    }
  } finally {
    try {
      await app.close();
    } finally {
      await telemetry.flush();
    }
  }

  return { statusCode, telemetryFlushed: true };
}

async function main(): Promise<void> {
  loadLocalEnvironment();
  applyPreviewEnvironment();
  const sourceVersion = resolveCommissioningSourceVersion();
  process.env.JARVIS_SOURCE_VERSION = sourceVersion;
  const telemetry = createPostHogTelemetryFromEnv();
  const receipt = await runPostHogCommissioning(telemetry);
  console.log(
    `Jarvis PostHog commissioning boundary completed at ${sourceVersion} with HTTP ${receipt.statusCode}; telemetry flush completed.`,
  );
}

const entryPoint = process.argv[1];
if (entryPoint && import.meta.url === pathToFileURL(entryPoint).href) {
  main().catch((error: unknown) => {
    console.error(error instanceof Error ? error.message : String(error));
    process.exitCode = 1;
  });
}
