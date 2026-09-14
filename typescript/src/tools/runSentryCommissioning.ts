import { execFileSync } from "node:child_process";
import { loadEnvFile } from "node:process";
import { fileURLToPath, pathToFileURL } from "node:url";

import { JarvisApiClient, JarvisApiError } from "../mcp/jarvisApiClient.js";
import { createPostHogTelemetryFromEnv } from "../observability/posthog.js";
import {
  createSentryRuntimeFromEnv,
  type SentryDeliveryObservation,
  type SentryRuntime,
} from "../observability/sentry.js";
import { createCommissioningApp } from "./runPostHogCommissioning.js";

export type SentryCommissioningReceipt = Readonly<{
  sourceVersion: string;
  statusCode: 503;
  deliveries: readonly SentryDeliveryObservation[];
  providerEvidence: "NOT_PROVEN";
  alertEvidence: "NOT_PROVEN";
}>;

export async function runSentryCommissioning(
  environment: NodeJS.ProcessEnv,
  sourceVersion: string,
): Promise<SentryCommissioningReceipt> {
  if (
    environment.JARVIS_ENVIRONMENT !== "development" ||
    environment.SENTRY_ENVIRONMENT !== "development"
  ) {
    throw new Error(
      "Sentry commissioning requires explicit Jarvis and Sentry development environments.",
    );
  }
  if (!/^[a-f0-9]{40}$/.test(sourceVersion)) {
    throw new Error("Sentry commissioning requires an exact source commit SHA.");
  }
  if (!environment.SENTRY_DSN?.trim()) {
    throw new Error(
      "Sentry commissioning requires an approved development DSN through the environment.",
    );
  }
  const deliveries: SentryDeliveryObservation[] = [];
  const runtime = createSentryRuntimeFromEnv(
    { ...environment, SENTRY_RELEASE: sourceVersion },
    (observation) => deliveries.push(observation),
  );
  // The API client emits telemetry without awaiting it. Track only this bounded
  // probe's two existing runtime calls so return is not mistaken for delivery.
  const pending: Promise<void>[] = [];
  const tracked: SentryRuntime = {
    enabled: runtime.enabled,
    captureError(error, context) {
      const work = runtime.captureError(error, context);
      pending.push(work);
      return work;
    },
    recordMeasurement(input) {
      const work = runtime.recordMeasurement(input);
      pending.push(work);
      return work;
    },
  };
  // Reuse the existing in-process commissioning app with inert persistence and
  // PostHog disabled. Its missing service-auth configuration deliberately yields
  // 503 before any domain handler, provider operation or business write.
  const app = await createCommissioningApp(createPostHogTelemetryFromEnv({}));
  try {
    const client = new JarvisApiClient(
      { baseUrl: new URL("http://127.0.0.1/"), serviceToken: "synthetic-commissioning-token" },
      async () => {
        const response = await app.inject({ method: "GET", url: "/api/v1/status" });
        return new Response(response.body, { status: response.statusCode });
      },
      tracked,
    );
    try {
      await client.getStatus();
      throw new Error("Commissioning did not observe the expected isolated failure.");
    } catch (error: unknown) {
      if (!(error instanceof JarvisApiError) || error.status !== 503) throw error;
    }
  } finally {
    try {
      await app.close();
    } finally {
      await Promise.all(pending);
    }
  }
  deliveries.sort((left, right) => left.eventType.localeCompare(right.eventType));
  if (
    deliveries.length !== 2 ||
    deliveries[0]?.eventType !== "error" ||
    deliveries[1]?.eventType !== "transaction"
  ) {
    throw new Error(
      "Commissioning did not observe the expected error and failure measurement deliveries.",
    );
  }
  return Object.freeze({
    sourceVersion,
    statusCode: 503,
    deliveries: Object.freeze([...deliveries]),
    providerEvidence: "NOT_PROVEN",
    alertEvidence: "NOT_PROVEN",
  });
}

async function main(): Promise<void> {
  try {
    loadEnvFile(".env.local");
  } catch (error: unknown) {
    if (!(error instanceof Error && "code" in error && error.code === "ENOENT")) throw error;
  }
  const sourceVersion = execFileSync("git", ["rev-parse", "HEAD"], {
    cwd: fileURLToPath(new URL("../../..", import.meta.url)),
    encoding: "utf8",
    stdio: ["ignore", "pipe", "ignore"],
  }).trim();
  const dirty = execFileSync("git", ["status", "--porcelain", "--untracked-files=normal"], {
    cwd: fileURLToPath(new URL("../../..", import.meta.url)),
    encoding: "utf8",
    stdio: ["ignore", "pipe", "ignore"],
  }).trim();
  if (dirty) throw new Error("Sentry commissioning requires a clean committed working tree.");
  const receipt = await runSentryCommissioning(process.env, sourceVersion);
  console.log(JSON.stringify(receipt));
  if (receipt.deliveries.some((delivery) => delivery.status !== "ACCEPTED")) process.exitCode = 1;
}

const entryPoint = process.argv[1];
if (entryPoint && import.meta.url === pathToFileURL(entryPoint).href) {
  main().catch(() => {
    console.error(
      "Sentry commissioning could not establish its bounded transport observations. Check development configuration and local verification; no provider success is claimed.",
    );
    process.exitCode = 1;
  });
}
