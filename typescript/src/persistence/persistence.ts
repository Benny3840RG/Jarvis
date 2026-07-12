import fs from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { ConvexHttpClient } from "convex/browser";
import { anyApi } from "convex/server";

export type AssistantState = {
  lastIntent?: string;
  lastInput?: string;
  lastResult?: unknown;
  lastReminder?: unknown;
  lastTask?: unknown;
  [key: string]: unknown;
};

export interface PersistenceProvider {
  loadState(): Promise<AssistantState>;
  saveState(state: AssistantState): Promise<void>;
}

export const assistantStateFunctions = {
  get: anyApi.assistantState.get,
  upsert: anyApi.assistantState.upsert,
};

function defaultDataPath(): string {
  const filename = fileURLToPath(import.meta.url);
  return path.resolve(path.dirname(filename), "../../data/jarvis-state.json");
}

function isNodeError(error: unknown): error is NodeJS.ErrnoException {
  return error instanceof Error && "code" in error;
}

export class JSONPersistence implements PersistenceProvider {
  constructor(private readonly filePath = defaultDataPath()) {}

  async loadState(): Promise<AssistantState> {
    try {
      const raw = await fs.readFile(this.filePath, "utf8");
      try {
        return JSON.parse(raw) as AssistantState;
      } catch (error: unknown) {
        const message = error instanceof Error ? error.message : String(error);
        throw new Error(`Malformed JSON in state file ${this.filePath}: ${message}`);
      }
    } catch (error: unknown) {
      if (isNodeError(error) && error.code === "ENOENT") return {};
      throw error;
    }
  }

  async saveState(state: AssistantState): Promise<void> {
    await fs.mkdir(path.dirname(this.filePath), { recursive: true });
    await fs.writeFile(this.filePath, JSON.stringify(state, null, 2), "utf8");
  }
}

export interface ConvexClientLike {
  query<T>(functionReference: unknown, args?: Record<string, never>): Promise<T>;
  mutation<T>(functionReference: unknown, args: Record<string, unknown>): Promise<T>;
}

export class ConvexPersistence implements PersistenceProvider {
  private readonly client: ConvexClientLike;

  constructor(client?: ConvexClientLike) {
    if (client) {
      this.client = client;
      return;
    }

    const convexUrl = process.env.CONVEX_URL;
    if (!convexUrl) {
      throw new Error("PERSISTENCE_PROVIDER=convex requires CONVEX_URL to be set in the environment.");
    }
    this.client = new ConvexHttpClient(convexUrl) as unknown as ConvexClientLike;
  }

  async loadState(): Promise<AssistantState> {
    const row = await this.client.query<{ state?: AssistantState } | null>(
      assistantStateFunctions.get,
      {},
    );
    return row?.state ?? {};
  }

  async saveState(state: AssistantState): Promise<void> {
    await this.client.mutation(assistantStateFunctions.upsert, { state });
  }
}

export function createPersistenceFromEnv(client?: ConvexClientLike): PersistenceProvider {
  const provider = (process.env.PERSISTENCE_PROVIDER ?? "json").trim().toLowerCase();
  if (provider === "" || provider === "json") return new JSONPersistence();
  if (provider === "convex") return new ConvexPersistence(client);
  throw new Error(
    `Invalid PERSISTENCE_PROVIDER '${process.env.PERSISTENCE_PROVIDER}'. Valid values: unset, json, convex.`,
  );
}
