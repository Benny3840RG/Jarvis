import { randomUUID } from "node:crypto";

import type { Client, ClientContact, ClientInput, ClientStore, ClientUpdate } from "./client.js";

function requiredName(name: string): string {
  const cleaned = name.trim();
  if (cleaned.length === 0) throw new Error("Client name cannot be empty.");
  return cleaned;
}

function normalizeContacts(contacts: ClientContact[] | undefined): ClientContact[] {
  if (!contacts) return [];
  const normalized: ClientContact[] = [];
  for (const contact of contacts) {
    const value = contact.value.trim();
    if (value.length === 0) continue;
    const label = contact.label?.trim();
    normalized.push(label ? { label, value } : { value });
  }
  return normalized;
}

function cloneClient(client: Client): Client {
  return { ...client, contacts: client.contacts.map((contact) => ({ ...contact })) };
}

/** In-memory ClientStore for tests and default HTTP wiring; nothing is persisted. */
export class InMemoryClientStore implements ClientStore {
  private readonly clients = new Map<string, Client>();

  list(): Promise<Client[]> {
    return Promise.resolve([...this.clients.values()].map(cloneClient));
  }

  get(id: string): Promise<Client | null> {
    const client = this.clients.get(id);
    return Promise.resolve(client ? cloneClient(client) : null);
  }

  add(input: ClientInput): Promise<Client> {
    const now = Date.now();
    const client: Client = {
      id: randomUUID(),
      name: requiredName(input.name),
      contacts: normalizeContacts(input.contacts),
      ...(input.notes && input.notes.trim() ? { notes: input.notes.trim() } : {}),
      createdAt: now,
      updatedAt: now,
    };
    this.clients.set(client.id, client);
    return Promise.resolve(cloneClient(client));
  }

  update(id: string, update: ClientUpdate): Promise<Client | null> {
    if (update.name === undefined && update.contacts === undefined && update.notes === undefined) {
      throw new Error("Client update requires a name, contacts, or notes change.");
    }
    const client = this.clients.get(id);
    if (!client) return Promise.resolve(null);
    if (update.name !== undefined) client.name = requiredName(update.name);
    if (update.contacts !== undefined) client.contacts = normalizeContacts(update.contacts);
    if (update.notes !== undefined) {
      const cleaned = update.notes === null ? "" : update.notes.trim();
      if (cleaned) client.notes = cleaned;
      else delete client.notes;
    }
    client.updatedAt = Date.now();
    return Promise.resolve(cloneClient(client));
  }

  remove(id: string): Promise<Client | null> {
    const client = this.clients.get(id);
    if (!client) return Promise.resolve(null);
    this.clients.delete(id);
    return Promise.resolve(cloneClient(client));
  }
}
