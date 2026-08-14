import { pathToFileURL } from "node:url";
import { loadEnvFile } from "node:process";
import { execFileSync } from "node:child_process";

import type { NestFastifyApplication } from "@nestjs/platform-fastify";

import { createJarvisHttpApp } from "../http/app.js";
import { JARVIS_VERSION } from "../http/config.js";
import {
  createPostHogCommissioningTelemetryFromEnv,
  type PostHogFlushReceipt,
  type PostHogTelemetry,
} from "../observability/posthog.js";
import type {
  AssistantState,
  PersistenceProvider,
  Reminder,
  ReminderUpdate,
  Task,
  TaskUpdate,
} from "../persistence/persistence.js";
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

function createCommissioningPersistence(): PersistenceProvider {
  return {
    async loadState(): Promise<AssistantState> {
      return {};
    },
    async saveState(): Promise<void> {},
    async listTasks(): Promise<Task[]> {
      return [];
    },
    async addTask(): Promise<Task> {
      throw new Error("Task writes are unavailable during PostHog commissioning.");
    },
    async updateTask(_id: string, _update: TaskUpdate): Promise<Task | null> {
      return null;
    },
    async completeTask(): Promise<Task | null> {
      return null;
    },
    async removeTask(): Promise<Task | null> {
      return null;
    },
    async listReminders(): Promise<Reminder[]> {
      return [];
    },
    async addReminder(): Promise<Reminder> {
      throw new Error("Reminder writes are unavailable during PostHog commissioning.");
    },
    async updateReminder(_id: string, _update: ReminderUpdate): Promise<Reminder | null> {
      return null;
    },
    async removeReminder(): Promise<Reminder | null> {
      return null;
    },
  };
}

function createCommissioningApp(telemetry: PostHogTelemetry): Promise<NestFastifyApplication> {
  return createJarvisHttpApp({
    persistence: createCommissioningPersistence(),
    providerName: "json",
    config: {
      version: JARVIS_VERSION,
      sourceVersion: process.env.JARVIS_SOURCE_VERSION?.trim() || "development",
      deploymentVersion: null,
    },
    externalReconciliationReadStore: null,
    totalityPipeline: null,
    memoryChangeSetService: null,
    toolActionService: null,
    toolExecutionService: null,
    quoteRepository: null,
    quoteDeliveryRepository: null,
    activityEventReader: null,
    telemetry,
    logger: false,
  });
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
  createApp: HttpAppFactory = () => createCommissioningApp(telemetry),
): Promise<PostHogCommissioningReceipt> {
  if (!telemetry.enabled) {
    throw new Error(
      "PostHog telemetry is not enabled. Set the development-only PostHog environment before commissioning.",
    );
  }

  const app = await createApp();
  let statusCode: number;
  let deliveryReceipt: PostHogFlushReceipt | undefined;
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
      deliveryReceipt = await telemetry.flush();
    }
  }

  if (
    deliveryReceipt.attempted !== 3 ||
    deliveryReceipt.accepted !== 3 ||
    deliveryReceipt.failed !== 0
  ) {
    throw new Error(
      `PostHog delivery failed: ${deliveryReceipt.accepted} of ${deliveryReceipt.attempted} events accepted.`,
    );
  }

  return { statusCode, telemetryFlushed: true };
}

async function main(): Promise<void> {
  loadLocalEnvironment();
  applyPreviewEnvironment();
  const sourceVersion = resolveCommissioningSourceVersion();
  process.env.JARVIS_SOURCE_VERSION = sourceVersion;
  const telemetry = createPostHogCommissioningTelemetryFromEnv();
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
