import fs from "fs/promises";
import path from "path";
import { fileURLToPath } from "url";

export type AssistantState = {
  lastIntent?: string;
  lastInput?: string;
  lastResult?: unknown;
  lastReminder?: unknown;
  [key: string]: unknown;
};

export interface PersistenceProvider {
  loadState(): Promise<AssistantState>;
  saveState(state: AssistantState): Promise<void>;
}

function defaultDataPath(): string {
  // Resolve typescript/data relative to this file without using __dirname.
  const __filename = fileURLToPath(import.meta.url);
  return path.resolve(path.dirname(__filename), "../../data/jarvis-state.json");
}

export class JSONPersistence implements PersistenceProvider {
  private filePath: string;

  constructor(filePath?: string) {
    this.filePath = filePath ?? defaultDataPath();
  }

  async loadState(): Promise<AssistantState> {
    try {
      const raw = await fs.readFile(this.filePath, { encoding: "utf8" });
      try {
        return JSON.parse(raw) as AssistantState;
      } catch (err) {
        throw new Error(`Malformed JSON in state file ${this.filePath}: ${(err as Error).message}`);
      }
    } catch (err: any) {
      if (err.code === "ENOENT") {
        // File doesn't exist: return empty state
        return {};
      }
      // Surface other errors (permissions, etc.)
      throw err;
    }
  }

  async saveState(state: AssistantState): Promise<void> {
    const dir = path.dirname(this.filePath);
    await fs.mkdir(dir, { recursive: true });
    const payload = JSON.stringify(state, null, 2);
    await fs.writeFile(this.filePath, payload, { encoding: "utf8" });
  }
}

// Convex types are imported as type-only so the runtime does not fail when convex
// is not installed. At runtime we accept an injected client or dynamically import
// the convex package only when needed.
import type { ConvexClient } from "convex";

export class ConvexPersistence implements PersistenceProvider {
  private client: ConvexClient | any;

  constructor(client?: any) {
    // If the environment requests convex as the provider, fail fast if CONVEX_URL is missing.
    if ((process.env.PERSISTENCE_PROVIDER ?? "json").toLowerCase() === "convex" && !process.env.CONVEX_URL) {
      throw new Error(
        "PERSISTENCE_PROVIDER=convex requires CONVEX_URL to be set in the environment."
      );
    }

    if (client) {
      this.client = client;
    }
  }

  private async ensureClient(): Promise<any> {
    if (this.client) return this.client;
    // Try to create a Convex client from the official package using CONVEX_URL.
    // We perform a dynamic import here so that repositories without the convex
    // package installed can still type-check and run tests that inject a mock client.
    try {
      const convexPkg = await import("convex");
      const ConvexClientCtor = (convexPkg as any).ConvexClient ?? (convexPkg as any).ConvexHttpClient ?? (convexPkg as any).default ?? (convexPkg as any).client;
      if (!ConvexClientCtor) {
        throw new Error("Could not find a Convex client constructor on the 'convex' package.");
      }
      // Construct with the documented CONVEX_URL
      this.client = new ConvexClientCtor({ url: process.env.CONVEX_URL });
      return this.client;
    } catch (err: any) {
      throw new Error(
        "Failed to load the 'convex' package or construct a client. Ensure 'convex' is installed in typescript/ and that CONVEX_URL is set. Original error: " + err?.message
      );
    }
  }

  async loadState(): Promise<AssistantState> {
    const client = await this.ensureClient();
    // Call the assistantState.get query (client-side wrapper will call the function name).
    const row = await client.query("assistantState/get");
    if (!row) return {};
    // Expect the row to have a 'state' JSON object.
    return (row.state ?? {}) as AssistantState;
  }

  async saveState(state: AssistantState): Promise<void> {
    const client = await this.ensureClient();
    // Call the assistantState upsert mutation. We pass the whole state as the single argument.
    await client.mutation("assistantState/upsert", state);
  }
}

export function createPersistenceFromEnv(client?: any): PersistenceProvider {
  const provider = (process.env.PERSISTENCE_PROVIDER ?? "json").toLowerCase();
  if (provider === "convex") {
    return new ConvexPersistence(client);
  }
  return new JSONPersistence();
}
