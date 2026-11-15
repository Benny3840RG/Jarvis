/**
 * One-time owner commissioning of NOLAN's dedicated voice project (#815).
 *
 * Voice safe writes ("Nolan, add a task: …") stage ToolActions against one
 * project the server resolves itself. That project must exist in Convex before
 * anything can be staged. This command creates it at revision 1 if, and only
 * if, it is absent. It is idempotent, never moves an existing project, never
 * stages, approves or executes anything, and prints no secret.
 *
 *   npm run commission:voice-project
 */

import { loadEnvFile } from "node:process";
import { pathToFileURL } from "node:url";

import { ConvexHttpClient } from "convex/browser";

import { api } from "../../convex/_generated/api.js";
import { resolvePersistenceProviderName } from "../persistence/providerSelection.js";
import { resolveVoiceProjectKey, VOICE_PROJECT_NAME } from "../voice/voiceWriteTarget.js";

export type VoiceProjectClient = {
  get(projectKey: string): Promise<{ revision: number } | null>;
  create(input: {
    projectKey: string;
    projectName: string;
    projectType: string;
    status: "active";
    createdAt: string;
    updatedAt: string;
    revision: 1;
    domains: string[];
    summary: string;
    preferences: {
      outputStyle: string;
      communicationTone: string;
      detailLevel: string;
      unitSystem: "metric";
      locale: "en-AU";
    };
  }): Promise<{ revision: number }>;
};

export type VoiceProjectCommissioningResult = {
  projectKey: string;
  revision: number;
  created: boolean;
};

export async function commissionVoiceProject(input: {
  client: VoiceProjectClient;
  projectKey: string;
  now?: () => Date;
}): Promise<VoiceProjectCommissioningResult> {
  const existing = await input.client.get(input.projectKey);
  if (existing) {
    return { projectKey: input.projectKey, revision: existing.revision, created: false };
  }
  const now = (input.now ?? (() => new Date()))().toISOString();
  const created = await input.client.create({
    projectKey: input.projectKey,
    projectName: VOICE_PROJECT_NAME,
    projectType: "voice",
    status: "active",
    createdAt: now,
    updatedAt: now,
    revision: 1,
    domains: ["voice"],
    summary:
      "Tasks and reminders dictated to NOLAN by voice. Every write is staged for owner approval.",
    preferences: {
      outputStyle: "concise",
      communicationTone: "direct",
      detailLevel: "normal",
      unitSystem: "metric",
      locale: "en-AU",
    },
  });
  return { projectKey: input.projectKey, revision: created.revision, created: true };
}

export function convexVoiceProjectClient(
  client: Pick<ConvexHttpClient, "query" | "mutation">,
  serviceToken: string,
): VoiceProjectClient {
  return {
    async get(projectKey) {
      return client.query(api.projects.get, { serviceToken, projectKey });
    },
    async create(project) {
      return client.mutation(api.projects.upsert, { serviceToken, ...project });
    },
  };
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
  if (resolvePersistenceProviderName() !== "convex") {
    throw new Error("Voice project commissioning refused: PERSISTENCE_PROVIDER must be convex.");
  }
  const convexUrl = process.env.CONVEX_URL?.trim();
  const serviceToken = process.env.JARVIS_SERVICE_TOKEN;
  if (!convexUrl || !serviceToken) {
    throw new Error(
      "Voice project commissioning refused: CONVEX_URL and JARVIS_SERVICE_TOKEN are required.",
    );
  }
  const result = await commissionVoiceProject({
    client: convexVoiceProjectClient(new ConvexHttpClient(convexUrl), serviceToken),
    projectKey: resolveVoiceProjectKey(),
  });
  process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
}

const entryPoint = process.argv[1];
if (entryPoint && import.meta.url === pathToFileURL(entryPoint).href) {
  main().catch((error: unknown) => {
    console.error(error instanceof Error ? error.message : String(error));
    process.exitCode = 1;
  });
}
