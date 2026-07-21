import { randomUUID } from "node:crypto";
import { promises as fs } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { JsonFileLock } from "../persistence/jsonFileLock.js";
import type { PersistenceWarning } from "../persistence/types.js";
import { applyUpgradeUpdate, cloneUpgrade, createUpgrade } from "./upgradeData.js";
import type { Upgrade, UpgradeInput, UpgradeStore, UpgradeUpdate } from "./upgrade.js";

const DOCUMENT_VERSION = 1 as const;

type UpgradeDocument = { version: number; entries: Upgrade[] };

function defaultUpgradesPath(): string {
  const filename = fileURLToPath(import.meta.url);
  return path.resolve(path.dirname(filename), "../../data/jarvis-upgrades.json");
}

function isNodeError(error: unknown): error is NodeJS.ErrnoException {
  return error instanceof Error && "code" in error;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function optionalText(value: unknown): string | undefined {
  return typeof value === "string" && value.trim() ? value : undefined;
}

function normalizeParts(value: unknown): string[] | undefined {
  if (!Array.isArray(value)) return undefined;
  const parts = value.filter(
    (item): item is string => typeof item === "string" && item.trim().length > 0,
  );
  return parts.length > 0 ? parts : undefined;
}

function normalizeEntry(value: unknown): Upgrade | null {
  if (!isRecord(value)) return null;
  if (
    typeof value.id !== "string" ||
    typeof value.buildId !== "string" ||
    typeof value.title !== "string"
  ) {
    return null;
  }
  const reason = optionalText(value.reason);
  const beforeState = optionalText(value.beforeState);
  const afterState = optionalText(value.afterState);
  const outcome = optionalText(value.outcome);
  const version = optionalText(value.version);
  const parts = normalizeParts(value.parts);
  return {
    id: value.id,
    buildId: value.buildId,
    title: value.title,
    ...(reason ? { reason } : {}),
    ...(beforeState ? { beforeState } : {}),
    ...(afterState ? { afterState } : {}),
    ...(outcome ? { outcome } : {}),
    ...(parts ? { parts } : {}),
    ...(version ? { version } : {}),
    ...(typeof value.occurredAt === "number" && Number.isFinite(value.occurredAt)
      ? { occurredAt: value.occurredAt }
      : {}),
    createdAt: typeof value.createdAt === "number" ? value.createdAt : Date.now(),
  };
}

export class JsonUpgradeStore implements UpgradeStore {
  private readonly writeLock: JsonFileLock;

  constructor(
    private readonly filePath: string = defaultUpgradesPath(),
    warn: PersistenceWarning = () => {},
    lockTimeoutMs = 5000,
  ) {
    this.writeLock = new JsonFileLock(filePath, warn, lockTimeoutMs);
  }

  private async readDocument(): Promise<UpgradeDocument> {
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
    const entries: Upgrade[] = [];
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

  private async writeDocument(document: UpgradeDocument): Promise<void> {
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

  async list(): Promise<Upgrade[]> {
    return (await this.readDocument()).entries.map(cloneUpgrade);
  }

  async get(id: string): Promise<Upgrade | null> {
    const entry = (await this.readDocument()).entries.find((candidate) => candidate.id === id);
    return entry ? cloneUpgrade(entry) : null;
  }

  async add(input: UpgradeInput): Promise<Upgrade> {
    return this.writeLock.run(async () => {
      const document = await this.readDocument();
      const entry = createUpgrade(input);
      document.entries.push(entry);
      await this.writeDocument(document);
      return cloneUpgrade(entry);
    }, "upgrade mutation");
  }

  async update(id: string, update: UpgradeUpdate): Promise<Upgrade | null> {
    return this.writeLock.run(async () => {
      const document = await this.readDocument();
      const entry = document.entries.find((candidate) => candidate.id === id);
      if (!entry) return null;
      applyUpgradeUpdate(entry, update);
      await this.writeDocument(document);
      return cloneUpgrade(entry);
    }, "upgrade mutation");
  }

  async remove(id: string): Promise<Upgrade | null> {
    return this.writeLock.run(async () => {
      const document = await this.readDocument();
      const index = document.entries.findIndex((candidate) => candidate.id === id);
      if (index === -1) return null;
      const [removed] = document.entries.splice(index, 1);
      await this.writeDocument(document);
      return cloneUpgrade(removed);
    }, "upgrade mutation");
  }
}
