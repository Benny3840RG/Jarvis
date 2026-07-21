import { randomUUID } from "node:crypto";
import { promises as fs } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { JsonFileLock } from "../persistence/jsonFileLock.js";
import type { PersistenceWarning } from "../persistence/types.js";
import { applyErrandUpdate, cloneErrand, createErrand, normalizeLocation } from "./errandData.js";
import {
  isErrandStatus,
  type Errand,
  type ErrandInput,
  type ErrandStatus,
  type ErrandStore,
  type ErrandUpdate,
} from "./errand.js";

const DOCUMENT_VERSION = 1 as const;

type ErrandDocument = { version: number; errands: Errand[] };

function defaultErrandsPath(): string {
  const filename = fileURLToPath(import.meta.url);
  return path.resolve(path.dirname(filename), "../../data/jarvis-errands.json");
}

function isNodeError(error: unknown): error is NodeJS.ErrnoException {
  return error instanceof Error && "code" in error;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function normalizeErrand(value: unknown): Errand | null {
  if (!isRecord(value)) return null;
  if (typeof value.id !== "string" || typeof value.title !== "string") return null;
  const status: ErrandStatus = isErrandStatus(value.status) ? value.status : "open";
  let location;
  if (value.location !== undefined) {
    try {
      location = normalizeLocation(value.location);
    } catch {
      location = undefined;
    }
  }
  const createdAt = typeof value.createdAt === "number" ? value.createdAt : Date.now();
  return {
    id: value.id,
    title: value.title,
    ...(typeof value.quantity === "number" && Number.isFinite(value.quantity) && value.quantity > 0
      ? { quantity: value.quantity }
      : {}),
    status,
    ...(location ? { location } : {}),
    ...(typeof value.projectId === "string" && value.projectId.trim()
      ? { projectId: value.projectId }
      : {}),
    ...(typeof value.notes === "string" && value.notes.trim() ? { notes: value.notes } : {}),
    createdAt,
    updatedAt: typeof value.updatedAt === "number" ? value.updatedAt : createdAt,
    ...(status === "done" && typeof value.completedAt === "number"
      ? { completedAt: value.completedAt }
      : {}),
  };
}

export class JsonErrandStore implements ErrandStore {
  private readonly writeLock: JsonFileLock;

  constructor(
    private readonly filePath: string = defaultErrandsPath(),
    warn: PersistenceWarning = () => {},
    lockTimeoutMs = 5000,
  ) {
    this.writeLock = new JsonFileLock(filePath, warn, lockTimeoutMs);
  }

  private async readDocument(): Promise<ErrandDocument> {
    let raw: string;
    try {
      raw = await fs.readFile(this.filePath, "utf8");
    } catch (error: unknown) {
      if (isNodeError(error) && error.code === "ENOENT")
        return { version: DOCUMENT_VERSION, errands: [] };
      throw error;
    }
    let parsed: unknown;
    try {
      parsed = JSON.parse(raw);
    } catch {
      await this.setAside();
      return { version: DOCUMENT_VERSION, errands: [] };
    }
    const errandsValue = isRecord(parsed) ? parsed.errands : undefined;
    const rows = Array.isArray(errandsValue) ? errandsValue : [];
    const errands: Errand[] = [];
    for (const row of rows) {
      const errand = normalizeErrand(row);
      if (errand) errands.push(errand);
    }
    return { version: DOCUMENT_VERSION, errands };
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

  private async writeDocument(document: ErrandDocument): Promise<void> {
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

  async list(): Promise<Errand[]> {
    return (await this.readDocument()).errands.map(cloneErrand);
  }

  async get(id: string): Promise<Errand | null> {
    const errand = (await this.readDocument()).errands.find((candidate) => candidate.id === id);
    return errand ? cloneErrand(errand) : null;
  }

  async add(input: ErrandInput): Promise<Errand> {
    return this.writeLock.run(async () => {
      const document = await this.readDocument();
      const errand = createErrand(input);
      document.errands.push(errand);
      await this.writeDocument(document);
      return cloneErrand(errand);
    }, "errand mutation");
  }

  async update(id: string, update: ErrandUpdate): Promise<Errand | null> {
    return this.writeLock.run(async () => {
      const document = await this.readDocument();
      const errand = document.errands.find((candidate) => candidate.id === id);
      if (!errand) return null;
      applyErrandUpdate(errand, update);
      await this.writeDocument(document);
      return cloneErrand(errand);
    }, "errand mutation");
  }

  async remove(id: string): Promise<Errand | null> {
    return this.writeLock.run(async () => {
      const document = await this.readDocument();
      const index = document.errands.findIndex((candidate) => candidate.id === id);
      if (index === -1) return null;
      const [removed] = document.errands.splice(index, 1);
      await this.writeDocument(document);
      return cloneErrand(removed);
    }, "errand mutation");
  }
}
