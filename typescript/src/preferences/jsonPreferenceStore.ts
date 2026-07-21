import { randomUUID } from "node:crypto";
import { promises as fs } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { JsonFileLock } from "../persistence/jsonFileLock.js";
import type { PersistenceWarning } from "../persistence/types.js";
import { applyPreferenceUpdate, clonePreference, createPreference } from "./preferenceData.js";
import type {
  Preference,
  PreferenceInput,
  PreferenceStore,
  PreferenceUpdate,
} from "./preference.js";

const DOCUMENT_VERSION = 1 as const;

type PreferenceDocument = { version: number; entries: Preference[] };

function defaultPreferencesPath(): string {
  const filename = fileURLToPath(import.meta.url);
  return path.resolve(path.dirname(filename), "../../data/jarvis-preferences.json");
}

function isNodeError(error: unknown): error is NodeJS.ErrnoException {
  return error instanceof Error && "code" in error;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function normalizeEntry(value: unknown): Preference | null {
  if (!isRecord(value)) return null;
  if (
    typeof value.id !== "string" ||
    typeof value.key !== "string" ||
    typeof value.value !== "string"
  ) {
    return null;
  }
  const now = Date.now();
  return {
    id: value.id,
    key: value.key,
    value: value.value,
    ...(typeof value.category === "string" && value.category.trim()
      ? { category: value.category }
      : {}),
    createdAt: typeof value.createdAt === "number" ? value.createdAt : now,
    updatedAt: typeof value.updatedAt === "number" ? value.updatedAt : now,
  };
}

export class JsonPreferenceStore implements PreferenceStore {
  private readonly writeLock: JsonFileLock;

  constructor(
    private readonly filePath: string = defaultPreferencesPath(),
    warn: PersistenceWarning = () => {},
    lockTimeoutMs = 5000,
  ) {
    this.writeLock = new JsonFileLock(filePath, warn, lockTimeoutMs);
  }

  private async readDocument(): Promise<PreferenceDocument> {
    let raw: string;
    try {
      raw = await fs.readFile(this.filePath, "utf8");
    } catch (error: unknown) {
      if (isNodeError(error) && error.code === "ENOENT")
        return { version: DOCUMENT_VERSION, entries: [] };
      throw error;
    }
    let parsed: unknown;
    try {
      parsed = JSON.parse(raw);
    } catch {
      await this.setAside();
      return { version: DOCUMENT_VERSION, entries: [] };
    }
    const entriesValue = isRecord(parsed) ? parsed.entries : undefined;
    const rows = Array.isArray(entriesValue) ? entriesValue : [];
    const entries: Preference[] = [];
    for (const row of rows) {
      const entry = normalizeEntry(row);
      if (entry) entries.push(entry);
    }
    return { version: DOCUMENT_VERSION, entries };
  }

  private async setAside(): Promise<void> {
    const corruptPath = `${this.filePath}.corrupt-${Date.now()}-${randomUUID()}`;
    try {
      await fs.rename(this.filePath, corruptPath);
    } catch (error: unknown) {
      if (isNodeError(error) && error.code === "ENOENT") return;
      throw error;
    }
  }

  private async writeDocument(document: PreferenceDocument): Promise<void> {
    await fs.mkdir(path.dirname(this.filePath), { recursive: true });
    const tempPath = path.join(
      path.dirname(this.filePath),
      `.${path.basename(this.filePath)}.tmp-${process.pid}-${randomUUID()}`,
    );
    const handle = await fs.open(tempPath, "w");
    try {
      await handle.writeFile(`${JSON.stringify(document, null, 2)}\n`, "utf8");
    } finally {
      await handle.close();
    }
    await fs.rename(tempPath, this.filePath);
  }

  async list(): Promise<Preference[]> {
    return (await this.readDocument()).entries.map(clonePreference);
  }

  async get(id: string): Promise<Preference | null> {
    const entry = (await this.readDocument()).entries.find((candidate) => candidate.id === id);
    return entry ? clonePreference(entry) : null;
  }

  async add(input: PreferenceInput): Promise<Preference> {
    return this.writeLock.run(async () => {
      const document = await this.readDocument();
      const entry = createPreference(input);
      document.entries.push(entry);
      await this.writeDocument(document);
      return clonePreference(entry);
    }, "preference mutation");
  }

  async update(id: string, update: PreferenceUpdate): Promise<Preference | null> {
    return this.writeLock.run(async () => {
      const document = await this.readDocument();
      const entry = document.entries.find((candidate) => candidate.id === id);
      if (!entry) return null;
      applyPreferenceUpdate(entry, update);
      await this.writeDocument(document);
      return clonePreference(entry);
    }, "preference mutation");
  }

  async remove(id: string): Promise<Preference | null> {
    return this.writeLock.run(async () => {
      const document = await this.readDocument();
      const index = document.entries.findIndex((candidate) => candidate.id === id);
      if (index === -1) return null;
      const [removed] = document.entries.splice(index, 1);
      await this.writeDocument(document);
      return clonePreference(removed);
    }, "preference mutation");
  }
}
