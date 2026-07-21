import { randomUUID } from "node:crypto";
import { promises as fs } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { JsonFileLock } from "../persistence/jsonFileLock.js";
import type { PersistenceWarning } from "../persistence/types.js";
import type { Client, ClientContact, ClientInput, ClientStore, ClientUpdate } from "./client.js";

const DOCUMENT_VERSION = 1 as const;

type ClientDocument = { version: number; clients: Client[] };

function defaultClientsPath(): string {
  const filename = fileURLToPath(import.meta.url);
  return path.resolve(path.dirname(filename), "../../data/jarvis-clients.json");
}

function isNodeError(error: unknown): error is NodeJS.ErrnoException {
  return error instanceof Error && "code" in error;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function requiredName(name: string): string {
  const cleaned = name.trim();
  if (cleaned.length === 0) throw new Error("Client name cannot be empty.");
  return cleaned;
}

function normalizeContacts(value: unknown): ClientContact[] {
  if (!Array.isArray(value)) return [];
  const contacts: ClientContact[] = [];
  for (const entry of value) {
    if (!isRecord(entry) || typeof entry.value !== "string") continue;
    const cleaned = entry.value.trim();
    if (cleaned.length === 0) continue;
    const label =
      typeof entry.label === "string" && entry.label.trim() ? entry.label.trim() : undefined;
    contacts.push(label === undefined ? { value: cleaned } : { label, value: cleaned });
  }
  return contacts;
}

function normalizeClient(value: unknown): Client | null {
  if (!isRecord(value)) return null;
  if (typeof value.id !== "string" || typeof value.name !== "string") return null;
  const createdAt = typeof value.createdAt === "number" ? value.createdAt : Date.now();
  return {
    id: value.id,
    name: value.name,
    contacts: normalizeContacts(value.contacts),
    ...(typeof value.notes === "string" && value.notes.trim() ? { notes: value.notes } : {}),
    createdAt,
    updatedAt: typeof value.updatedAt === "number" ? value.updatedAt : createdAt,
  };
}

function cloneClient(client: Client): Client {
  return {
    ...client,
    contacts: client.contacts.map((contact) => ({ ...contact })),
  };
}

export class JsonClientStore implements ClientStore {
  private readonly writeLock: JsonFileLock;

  constructor(
    private readonly filePath: string = defaultClientsPath(),
    warn: PersistenceWarning = () => {},
    lockTimeoutMs = 5000,
  ) {
    this.writeLock = new JsonFileLock(filePath, warn, lockTimeoutMs);
  }

  private async readDocument(): Promise<ClientDocument> {
    let raw: string;
    try {
      raw = await fs.readFile(this.filePath, "utf8");
    } catch (error: unknown) {
      if (isNodeError(error) && error.code === "ENOENT")
        return { version: DOCUMENT_VERSION, clients: [] };
      throw error;
    }
    let parsed: unknown;
    try {
      parsed = JSON.parse(raw);
    } catch {
      await this.setAside();
      return { version: DOCUMENT_VERSION, clients: [] };
    }
    const clientsValue = isRecord(parsed) ? parsed.clients : undefined;
    const rows = Array.isArray(clientsValue) ? clientsValue : [];
    const clients: Client[] = [];
    for (const row of rows) {
      const client = normalizeClient(row);
      if (client) clients.push(client);
    }
    return { version: DOCUMENT_VERSION, clients };
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

  private async writeDocument(document: ClientDocument): Promise<void> {
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

  async list(): Promise<Client[]> {
    return (await this.readDocument()).clients.map(cloneClient);
  }

  async get(id: string): Promise<Client | null> {
    const client = (await this.readDocument()).clients.find((candidate) => candidate.id === id);
    return client ? cloneClient(client) : null;
  }

  async add(input: ClientInput): Promise<Client> {
    return this.writeLock.run(async () => {
      const document = await this.readDocument();
      const now = Date.now();
      const client: Client = {
        id: randomUUID(),
        name: requiredName(input.name),
        contacts: normalizeContacts(input.contacts),
        ...(input.notes && input.notes.trim() ? { notes: input.notes.trim() } : {}),
        createdAt: now,
        updatedAt: now,
      };
      document.clients.push(client);
      await this.writeDocument(document);
      return cloneClient(client);
    }, "client mutation");
  }

  async update(id: string, update: ClientUpdate): Promise<Client | null> {
    if (update.name === undefined && update.contacts === undefined && update.notes === undefined) {
      throw new Error("Client update requires a name, contacts, or notes change.");
    }
    return this.writeLock.run(async () => {
      const document = await this.readDocument();
      const client = document.clients.find((candidate) => candidate.id === id);
      if (!client) return null;
      if (update.name !== undefined) client.name = requiredName(update.name);
      if (update.contacts !== undefined) client.contacts = normalizeContacts(update.contacts);
      if (update.notes !== undefined) {
        const cleaned = update.notes === null ? "" : update.notes.trim();
        if (cleaned) client.notes = cleaned;
        else delete client.notes;
      }
      client.updatedAt = Date.now();
      await this.writeDocument(document);
      return cloneClient(client);
    }, "client mutation");
  }

  async remove(id: string): Promise<Client | null> {
    return this.writeLock.run(async () => {
      const document = await this.readDocument();
      const index = document.clients.findIndex((candidate) => candidate.id === id);
      if (index === -1) return null;
      const [removed] = document.clients.splice(index, 1);
      await this.writeDocument(document);
      return cloneClient(removed);
    }, "client mutation");
  }
}
