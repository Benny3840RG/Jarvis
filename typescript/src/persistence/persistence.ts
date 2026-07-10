import fs from "fs/promises";
import path from "path";

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

export class JSONPersistence implements PersistenceProvider {
  private filePath: string;

  constructor(filePath?: string) {
    this.filePath = filePath ?? path.resolve(__dirname, "../../data/jarvis-state.json");
  }

  async loadState(): Promise<AssistantState> {
    try {
      const raw = await fs.readFile(this.filePath, { encoding: "utf8" });
      return JSON.parse(raw) as AssistantState;
    } catch (err: any) {
      // If file doesn't exist or is invalid, return empty state
      return {};
    }
  }

  async saveState(state: AssistantState): Promise<void> {
    const dir = path.dirname(this.filePath);
    try {
      await fs.mkdir(dir, { recursive: true });
      await fs.writeFile(this.filePath, JSON.stringify(state, null, 2), { encoding: "utf8" });
    } catch (err) {
      throw err;
    }
  }
}

/**
 * ConvexPersistence is a thin runtime wrapper around a Convex client.
 * This implementation intentionally uses dynamic import so the project can be
 * type-checked and tested without Convex being configured or installed.
 *
 * It will throw helpful errors if Convex is not configured at runtime.
 */
export class ConvexPersistence implements PersistenceProvider {
  private client: any | null = null;

  constructor(client?: any) {
    if (client) this.client = client;
  }

  private async ensureClient() {
    if (this.client) return this.client;

    // Try to dynamically import the convex client package.
    try {
      // Many convex client bundles export a default or named client. We accept either.
      // We avoid importing at top-level so tests that don't install convex still run.
      const convexPkg = await import("convex");
      // Heuristics to find a client constructor / factory
      const ConvexClient = (convexPkg as any).ConvexClient ?? (convexPkg as any).default ?? (convexPkg as any).client;
      if (!ConvexClient) {
        // If the package shape isn't what we expect, just keep the raw package.
        this.client = convexPkg;
      } else {
        // If an env variable like CONVEX_URL exists we could instantiate here.
        // We don't auto-instantiate to avoid creating credentials in repo. Leave to caller.
        this.client = ConvexClient;
      }
      return this.client;
    } catch (err) {
      throw new Error(
        "The 'convex' package is not installed or could not be imported. Run 'npm install' in typescript/ to add Convex, and set up credentials before using PERSISTENCE_PROVIDER=convex."
      );
    }
  }

  async loadState(): Promise<AssistantState> {
    // Minimal safe behaviour: if convex isn't configured return empty state, but surface a clear message.
    const client = await this.ensureClient();
    // Real Convex integration would query a table named 'assistantState' and return the latest row.
    // We avoid making assumptions about authentication/deployment in this repo commit.
    throw new Error("ConvexPersistence.loadState is not fully implemented in this repository commit. Please configure Convex and complete the deployment-specific wiring.");
  }

  async saveState(_state: AssistantState): Promise<void> {
    const client = await this.ensureClient();
    throw new Error("ConvexPersistence.saveState is not fully implemented in this repository commit. Please configure Convex and complete the deployment-specific wiring.");
  }
}

export function createPersistenceFromEnv(): PersistenceProvider {
  const provider = (process.env.PERSISTENCE_PROVIDER ?? "json").toLowerCase();
  if (provider === "convex") {
    return new ConvexPersistence();
  }
  // Default and fallback
  return new JSONPersistence();
}
