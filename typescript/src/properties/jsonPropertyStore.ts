import { randomUUID } from "node:crypto";
import { promises as fs } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { writePrivateJsonFile } from "../persistence/atomicJsonFile.js";
import { JsonFileLock } from "../persistence/jsonFileLock.js";
import type { PersistenceWarning } from "../persistence/types.js";
import type { Property, PropertyInput, PropertyStore, PropertyUpdate } from "./property.js";

const DOCUMENT_VERSION = 1 as const;

type PropertyDocument = { version: number; properties: Property[] };

function defaultPropertiesPath(): string {
  const filename = fileURLToPath(import.meta.url);
  return path.resolve(path.dirname(filename), "../../data/jarvis-properties.json");
}

function isNodeError(error: unknown): error is NodeJS.ErrnoException {
  return error instanceof Error && "code" in error;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function requiredString(value: string, field: string): string {
  const cleaned = value.trim();
  if (cleaned.length === 0) throw new Error(`${field} cannot be empty.`);
  return cleaned;
}

function normalizeHazards(value: unknown): string[] {
  if (!Array.isArray(value)) return [];
  const hazards = value
    .filter((hazard): hazard is string => typeof hazard === "string")
    .map((hazard) => hazard.trim())
    .filter(Boolean);
  return [...new Set(hazards)];
}

function optionalText(value: unknown): string | undefined {
  return typeof value === "string" && value.trim() ? value.trim() : undefined;
}

function normalizeProperty(value: unknown): Property {
  if (!isRecord(value)) throw new Error("Property row is not a record");
  if (
    typeof value.id !== "string" ||
    typeof value.clientId !== "string" ||
    typeof value.address !== "string"
  ) {
    throw new Error("Property row missing required fields");
  }
  if (!Number.isFinite(value.createdAt)) throw new Error("Property row has non-finite createdAt");
  const createdAt = value.createdAt as number;
  return {
    id: value.id,
    clientId: requiredString(value.clientId, "Property clientId"),
    address: requiredString(value.address, "Property address"),
    hazards: normalizeHazards(value.hazards),
    ...(optionalText(value.accessNotes) === undefined
      ? {}
      : { accessNotes: optionalText(value.accessNotes) }),
    ...(optionalText(value.serviceNotes) === undefined
      ? {}
      : { serviceNotes: optionalText(value.serviceNotes) }),
    createdAt,
    updatedAt: typeof value.updatedAt === "number" ? value.updatedAt : createdAt,
  };
}

function cloneProperty(property: Property): Property {
  return { ...property, hazards: [...property.hazards] };
}

export class JsonPropertyStore implements PropertyStore {
  private readonly writeLock: JsonFileLock;

  constructor(
    private readonly filePath: string = defaultPropertiesPath(),
    warn: PersistenceWarning = () => {},
    lockTimeoutMs = 5000,
  ) {
    this.writeLock = new JsonFileLock(filePath, warn, lockTimeoutMs);
  }

  private async readDocument(lockHeld = false): Promise<PropertyDocument> {
    let raw: string;
    try {
      raw = await fs.readFile(this.filePath, "utf8");
    } catch (error: unknown) {
      if (isNodeError(error) && error.code === "ENOENT")
        return { version: DOCUMENT_VERSION, properties: [] };
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
      return { version: DOCUMENT_VERSION, properties: [] };
    }
    const rows = isRecord(parsed) && Array.isArray(parsed.properties) ? parsed.properties : [];
    const properties: Property[] = [];
    try {
      for (const row of rows) {
        properties.push(normalizeProperty(row));
      }
    } catch {
      if (!lockHeld) {
        return this.writeLock.run(() => this.readDocument(true), "corruption recovery");
      }
      await this.setAside();
      return { version: DOCUMENT_VERSION, properties: [] };
    }
    return { version: DOCUMENT_VERSION, properties };
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

  private async writeDocument(document: PropertyDocument): Promise<void> {
    await writePrivateJsonFile(this.filePath, document);
  }

  async list(filter: { clientId?: string } = {}): Promise<Property[]> {
    return (await this.readDocument()).properties
      .filter((property) => filter.clientId === undefined || property.clientId === filter.clientId)
      .map(cloneProperty);
  }

  async get(id: string): Promise<Property | null> {
    const property = (await this.readDocument()).properties.find(
      (candidate) => candidate.id === id,
    );
    return property ? cloneProperty(property) : null;
  }

  async add(input: PropertyInput): Promise<Property> {
    return this.writeLock.run(async () => {
      const document = await this.readDocument(true);
      const now = Date.now();
      const property: Property = {
        id: randomUUID(),
        clientId: requiredString(input.clientId, "Property clientId"),
        address: requiredString(input.address, "Property address"),
        hazards: normalizeHazards(input.hazards),
        ...(optionalText(input.accessNotes) === undefined
          ? {}
          : { accessNotes: optionalText(input.accessNotes) }),
        ...(optionalText(input.serviceNotes) === undefined
          ? {}
          : { serviceNotes: optionalText(input.serviceNotes) }),
        createdAt: now,
        updatedAt: now,
      };
      document.properties.push(property);
      await this.writeDocument(document);
      return cloneProperty(property);
    }, "property mutation");
  }

  async update(id: string, update: PropertyUpdate): Promise<Property | null> {
    if (
      update.clientId === undefined &&
      update.address === undefined &&
      update.hazards === undefined &&
      update.accessNotes === undefined &&
      update.serviceNotes === undefined
    ) {
      throw new Error("Property update requires at least one changed field.");
    }
    return this.writeLock.run(async () => {
      const document = await this.readDocument(true);
      const property = document.properties.find((candidate) => candidate.id === id);
      if (!property) return null;
      if (update.clientId !== undefined)
        property.clientId = requiredString(update.clientId, "Property clientId");
      if (update.address !== undefined)
        property.address = requiredString(update.address, "Property address");
      if (update.hazards !== undefined) property.hazards = normalizeHazards(update.hazards);
      if (update.accessNotes !== undefined) {
        const cleaned = update.accessNotes === null ? "" : update.accessNotes.trim();
        if (cleaned) property.accessNotes = cleaned;
        else delete property.accessNotes;
      }
      if (update.serviceNotes !== undefined) {
        const cleaned = update.serviceNotes === null ? "" : update.serviceNotes.trim();
        if (cleaned) property.serviceNotes = cleaned;
        else delete property.serviceNotes;
      }
      property.updatedAt = Date.now();
      await this.writeDocument(document);
      return cloneProperty(property);
    }, "property mutation");
  }

  async remove(id: string): Promise<Property | null> {
    return this.writeLock.run(async () => {
      const document = await this.readDocument(true);
      const index = document.properties.findIndex((candidate) => candidate.id === id);
      if (index === -1) return null;
      const [removed] = document.properties.splice(index, 1);
      await this.writeDocument(document);
      return cloneProperty(removed);
    }, "property mutation");
  }
}
