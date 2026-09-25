import { randomUUID } from "node:crypto";
import { promises as fs } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { writePrivateJsonFile } from "../persistence/atomicJsonFile.js";
import { JsonFileLock } from "../persistence/jsonFileLock.js";
import type { PersistenceWarning } from "../persistence/types.js";
import { applyBuildLogUpdate, cloneBuildLogEntry, createBuildLogEntry } from "./buildLogData.js";
import {
  isBuildLogKind,
  type BuildLogEntry,
  type BuildLogInput,
  type BuildLogKind,
  type BuildLogStore,
  type BuildLogUpdate,
} from "./buildLogEntry.js";

const DOCUMENT_VERSION = 1 as const;

type BuildLogDocument = { version: number; entries: BuildLogEntry[] };

function defaultBuildLogsPath(): string {
  const filename = fileURLToPath(import.meta.url);
  return path.resolve(path.dirname(filename), "../../data/jarvis-build-logs.json");
}

function isNodeError(error: unknown): error is NodeJS.ErrnoException {
  return error instanceof Error && "code" in error;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function normalizeEntry(value: unknown): BuildLogEntry {
  if (!isRecord(value)) throw new Error("BuildLogEntry row is not a record");
  if (
    typeof value.id !== "string" ||
    typeof value.buildId !== "string" ||
    typeof value.title !== "string"
  ) {
    throw new Error("BuildLogEntry row missing required fields");
  }
  const kind: BuildLogKind = isBuildLogKind(value.kind) ? value.kind : "note";
  if (!Number.isFinite(value.createdAt))
    throw new Error("BuildLogEntry row has non-finite createdAt");
  const createdAt = value.createdAt as number;
  return {
    id: value.id,
    buildId: value.buildId,
    kind,
    title: value.title,
    ...(typeof value.body === "string" && value.body.trim() ? { body: value.body } : {}),
    ...(typeof value.occurredAt === "number" && Number.isFinite(value.occurredAt)
      ? { occurredAt: value.occurredAt }
      : {}),
    createdAt,
    ...(typeof value.updatedAt === "number" ? { updatedAt: value.updatedAt } : {}),
  };
}

export class JsonBuildLogStore implements BuildLogStore {
  private readonly writeLock: JsonFileLock;

  constructor(
    private readonly filePath: string = defaultBuildLogsPath(),
    warn: PersistenceWarning = () => {},
    lockTimeoutMs = 5000,
  ) {
    this.writeLock = new JsonFileLock(filePath, warn, lockTimeoutMs);
  }

  private async readDocument(lockHeld = false): Promise<BuildLogDocument> {
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
      if (!lockHeld) {
        return this.writeLock.run(() => this.readDocument(true), "corruption recovery");
      }
      await this.setAside();
      return { version: DOCUMENT_VERSION, entries: [] };
    }
    const entriesValue = isRecord(parsed) ? parsed.entries : undefined;
    const rows = Array.isArray(entriesValue) ? entriesValue : [];
    const entries: BuildLogEntry[] = [];
    try {
      for (const row of rows) {
        entries.push(normalizeEntry(row));
      }
    } catch {
      if (!lockHeld) {
        return this.writeLock.run(() => this.readDocument(true), "corruption recovery");
      }
      await this.setAside();
      return { version: DOCUMENT_VERSION, entries: [] };
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

  private async writeDocument(document: BuildLogDocument): Promise<void> {
    await writePrivateJsonFile(this.filePath, document);
  }

  async list(): Promise<BuildLogEntry[]> {
    return (await this.readDocument()).entries.map(cloneBuildLogEntry);
  }

  async get(id: string): Promise<BuildLogEntry | null> {
    const entry = (await this.readDocument()).entries.find((candidate) => candidate.id === id);
    return entry ? cloneBuildLogEntry(entry) : null;
  }

  async add(input: BuildLogInput): Promise<BuildLogEntry> {
    return this.writeLock.run(async () => {
      const document = await this.readDocument(true);
      const entry = createBuildLogEntry(input);
      document.entries.push(entry);
      await this.writeDocument(document);
      return cloneBuildLogEntry(entry);
    }, "build log mutation");
  }

  async update(id: string, update: BuildLogUpdate): Promise<BuildLogEntry | null> {
    return this.writeLock.run(async () => {
      const document = await this.readDocument(true);
      const entry = document.entries.find((candidate) => candidate.id === id);
      if (!entry) return null;
      applyBuildLogUpdate(entry, update);
      await this.writeDocument(document);
      return cloneBuildLogEntry(entry);
    }, "build log mutation");
  }

  async remove(id: string): Promise<BuildLogEntry | null> {
    return this.writeLock.run(async () => {
      const document = await this.readDocument(true);
      const index = document.entries.findIndex((candidate) => candidate.id === id);
      if (index === -1) return null;
      const [removed] = document.entries.splice(index, 1);
      await this.writeDocument(document);
      return cloneBuildLogEntry(removed);
    }, "build log mutation");
  }
}
