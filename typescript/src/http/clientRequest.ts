import type { ClientContact, ClientInput, ClientUpdate } from "../clients/client.js";

const MAX_NAME_LENGTH = 200;
const MAX_NOTES_LENGTH = 2000;
const MAX_CONTACT_LENGTH = 200;
const MAX_CONTACTS = 20;

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function requiredString(value: unknown, field: string, max: number): string {
  if (typeof value !== "string" || value.trim().length === 0) {
    throw new Error(`${field} must be a non-empty string.`);
  }
  if (value.trim().length > max) throw new Error(`${field} must not exceed ${max} characters.`);
  return value.trim();
}

function rejectUnknownKeys(body: Record<string, unknown>, allowed: readonly string[]): void {
  if (Object.keys(body).some((key) => !allowed.includes(key))) {
    throw new Error("Request contains unsupported fields.");
  }
}

function parseContacts(value: unknown): ClientContact[] {
  if (!Array.isArray(value)) throw new Error("Client contacts must be an array.");
  if (value.length > MAX_CONTACTS) throw new Error(`No more than ${MAX_CONTACTS} contacts.`);
  return value.map((entry) => {
    if (!isRecord(entry)) throw new Error("Each contact must be an object.");
    rejectUnknownKeys(entry, ["label", "value"]);
    const contact: ClientContact = {
      value: requiredString(entry.value, "Contact value", MAX_CONTACT_LENGTH),
    };
    if (entry.label !== undefined)
      contact.label = requiredString(entry.label, "Contact label", MAX_CONTACT_LENGTH);
    return contact;
  });
}

export function parseCreateClient(body: unknown): ClientInput {
  if (!isRecord(body)) throw new Error("Request body must be a JSON object.");
  rejectUnknownKeys(body, ["name", "contacts", "notes"]);
  return {
    name: requiredString(body.name, "Client name", MAX_NAME_LENGTH),
    ...(body.contacts === undefined ? {} : { contacts: parseContacts(body.contacts) }),
    ...(body.notes === undefined
      ? {}
      : { notes: requiredString(body.notes, "Client notes", MAX_NOTES_LENGTH) }),
  };
}

export function parseUpdateClient(body: unknown): ClientUpdate {
  if (!isRecord(body)) throw new Error("Request body must be a JSON object.");
  rejectUnknownKeys(body, ["name", "contacts", "notes"]);
  if (body.name === undefined && body.contacts === undefined && body.notes === undefined) {
    throw new Error("Client update requires a name, contacts, or notes change.");
  }
  const update: ClientUpdate = {};
  if (body.name !== undefined)
    update.name = requiredString(body.name, "Client name", MAX_NAME_LENGTH);
  if (body.contacts !== undefined) update.contacts = parseContacts(body.contacts);
  if (body.notes !== undefined) {
    update.notes =
      body.notes === null ? null : requiredString(body.notes, "Client notes", MAX_NOTES_LENGTH);
  }
  return update;
}
