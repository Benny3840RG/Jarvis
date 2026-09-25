import { randomUUID } from "node:crypto";
import { promises as fs } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { writePrivateJsonFile } from "../persistence/atomicJsonFile.js";
import { JsonFileLock } from "../persistence/jsonFileLock.js";
import type { PersistenceWarning } from "../persistence/types.js";
import { applyAssetUpdate, cloneAsset, createAsset } from "./assetData.js";
import type { Asset, AssetInput, AssetStore, AssetUpdate } from "./asset.js";

const DOCUMENT_VERSION = 1 as const;

type AssetDocument = { version: number; entries: Asset[] };

function defaultAssetsPath(): string {
  const filename = fileURLToPath(import.meta.url);
  return path.resolve(path.dirname(filename), "../../data/jarvis-assets.json");
}

function isNodeError(error: unknown): error is NodeJS.ErrnoException {
  return error instanceof Error && "code" in error;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isPositiveInt(value: unknown): value is number {
  return typeof value === "number" && Number.isInteger(value) && value > 0;
}

function normalizeEntry(value: unknown): Asset {
  if (!isRecord(value)) throw new Error("Asset row is not a record");
  if (
    typeof value.id !== "string" ||
    typeof value.name !== "string" ||
    typeof value.kind !== "string"
  ) {
    throw new Error("Asset row missing required fields");
  }
  if (!Number.isFinite(value.createdAt)) throw new Error("Asset row has non-finite createdAt");
  const createdAt = value.createdAt as number;
  const updatedAtValue = Number.isFinite(value.updatedAt) ? (value.updatedAt as number) : createdAt;
  return {
    id: value.id,
    name: value.name,
    kind: value.kind,
    ...(isPositiveInt(value.serviceIntervalDays)
      ? { serviceIntervalDays: value.serviceIntervalDays }
      : {}),
    ...(typeof value.lastServicedAt === "number" && Number.isFinite(value.lastServicedAt)
      ? { lastServicedAt: value.lastServicedAt }
      : {}),
    ...(typeof value.notes === "string" && value.notes.trim() ? { notes: value.notes } : {}),
    createdAt,
    updatedAt: updatedAtValue,
  };
}

export class JsonAssetStore implements AssetStore {
  private readonly writeLock: JsonFileLock;

  constructor(
    private readonly filePath: string = defaultAssetsPath(),
    warn: PersistenceWarning = () => {},
    lockTimeoutMs = 5000,
  ) {
    this.writeLock = new JsonFileLock(filePath, warn, lockTimeoutMs);
  }

  private async readDocument(lockHeld = false): Promise<AssetDocument> {
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
    const entries: Asset[] = [];
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

  private async writeDocument(document: AssetDocument): Promise<void> {
    await writePrivateJsonFile(this.filePath, document);
  }

  async list(): Promise<Asset[]> {
    return (await this.readDocument()).entries.map(cloneAsset);
  }

  async get(id: string): Promise<Asset | null> {
    const entry = (await this.readDocument()).entries.find((candidate) => candidate.id === id);
    return entry ? cloneAsset(entry) : null;
  }

  async add(input: AssetInput): Promise<Asset> {
    return this.writeLock.run(async () => {
      const document = await this.readDocument(true);
      const entry = createAsset(input);
      document.entries.push(entry);
      await this.writeDocument(document);
      return cloneAsset(entry);
    }, "asset mutation");
  }

  async update(id: string, update: AssetUpdate): Promise<Asset | null> {
    return this.writeLock.run(async () => {
      const document = await this.readDocument(true);
      const entry = document.entries.find((candidate) => candidate.id === id);
      if (!entry) return null;
      applyAssetUpdate(entry, update);
      await this.writeDocument(document);
      return cloneAsset(entry);
    }, "asset mutation");
  }

  async remove(id: string): Promise<Asset | null> {
    return this.writeLock.run(async () => {
      const document = await this.readDocument(true);
      const index = document.entries.findIndex((candidate) => candidate.id === id);
      if (index === -1) return null;
      const [removed] = document.entries.splice(index, 1);
      await this.writeDocument(document);
      return cloneAsset(removed);
    }, "asset mutation");
  }
}
