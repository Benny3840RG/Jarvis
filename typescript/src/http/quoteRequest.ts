import {
  isQuoteStatus,
  type QuoteInput,
  type QuoteLineItem,
  type QuoteStatus,
  type QuoteUpdate,
  QUOTE_STATUSES,
} from "../quotes/quote.js";

const MAX_ID_LENGTH = 200;
const MAX_NUMBER_LENGTH = 100;
const MAX_DESCRIPTION_LENGTH = 500;
const MAX_NOTES_LENGTH = 2000;
const MAX_VALID_UNTIL_LENGTH = 100;
const MAX_LINE_ITEMS = 200;

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

function nonNegativeNumber(value: unknown, field: string): number {
  if (typeof value !== "number" || !Number.isFinite(value) || value < 0) {
    throw new Error(`${field} must be a non-negative number.`);
  }
  return value;
}

function parseStatus(value: unknown): QuoteStatus {
  if (!isQuoteStatus(value)) {
    throw new Error(`Quote status must be one of: ${QUOTE_STATUSES.join(", ")}.`);
  }
  return value;
}

function parseTaxRate(value: unknown): number {
  if (typeof value !== "number" || !Number.isFinite(value) || value < 0 || value > 1) {
    throw new Error("Quote taxRate must be a number between 0 and 1.");
  }
  return value;
}

function parseLineItems(value: unknown): QuoteLineItem[] {
  if (!Array.isArray(value)) throw new Error("Quote lineItems must be an array.");
  if (value.length > MAX_LINE_ITEMS) {
    throw new Error(`Quote lineItems must not exceed ${MAX_LINE_ITEMS} entries.`);
  }
  return value.map((entry, index) => {
    if (!isRecord(entry)) throw new Error(`Line item ${index + 1} must be a JSON object.`);
    const allowed = ["description", "quantity", "unitPrice"];
    if (Object.keys(entry).some((key) => !allowed.includes(key))) {
      throw new Error(`Line item ${index + 1} contains unsupported fields.`);
    }
    return {
      description: requiredString(
        entry.description,
        `Line item ${index + 1} description`,
        MAX_DESCRIPTION_LENGTH,
      ),
      quantity: nonNegativeNumber(entry.quantity, `Line item ${index + 1} quantity`),
      unitPrice: nonNegativeNumber(entry.unitPrice, `Line item ${index + 1} unitPrice`),
    };
  });
}

function rejectUnknownKeys(body: Record<string, unknown>, allowed: readonly string[]): void {
  if (Object.keys(body).some((key) => !allowed.includes(key))) {
    throw new Error("Request contains unsupported fields.");
  }
}

// Note: subtotal, tax, and total are intentionally NOT accepted from the request.
// They are always derived server-side from the line items and tax rate.
const ALLOWED = [
  "clientId",
  "projectId",
  "number",
  "status",
  "lineItems",
  "taxRate",
  "validUntil",
  "notes",
] as const;

export function parseCreateQuote(body: unknown): QuoteInput {
  if (!isRecord(body)) throw new Error("Request body must be a JSON object.");
  rejectUnknownKeys(body, ALLOWED);
  return {
    clientId: requiredString(body.clientId, "Quote clientId", MAX_ID_LENGTH),
    number: requiredString(body.number, "Quote number", MAX_NUMBER_LENGTH),
    ...(body.projectId === undefined
      ? {}
      : { projectId: requiredString(body.projectId, "Quote projectId", MAX_ID_LENGTH) }),
    ...(body.status === undefined ? {} : { status: parseStatus(body.status) }),
    ...(body.lineItems === undefined ? {} : { lineItems: parseLineItems(body.lineItems) }),
    ...(body.taxRate === undefined ? {} : { taxRate: parseTaxRate(body.taxRate) }),
    ...(body.validUntil === undefined
      ? {}
      : {
          validUntil: requiredString(body.validUntil, "Quote validUntil", MAX_VALID_UNTIL_LENGTH),
        }),
    ...(body.notes === undefined
      ? {}
      : { notes: requiredString(body.notes, "Quote notes", MAX_NOTES_LENGTH) }),
  };
}

export function parseUpdateQuote(body: unknown): QuoteUpdate {
  if (!isRecord(body)) throw new Error("Request body must be a JSON object.");
  rejectUnknownKeys(body, ALLOWED);
  if (Object.keys(body).length === 0) {
    throw new Error("Quote update requires at least one changed field.");
  }
  const update: QuoteUpdate = {};
  if (body.clientId !== undefined)
    update.clientId = requiredString(body.clientId, "Quote clientId", MAX_ID_LENGTH);
  if (body.number !== undefined)
    update.number = requiredString(body.number, "Quote number", MAX_NUMBER_LENGTH);
  if (body.status !== undefined) update.status = parseStatus(body.status);
  if (body.lineItems !== undefined) update.lineItems = parseLineItems(body.lineItems);
  if (body.projectId !== undefined) {
    update.projectId =
      body.projectId === null
        ? null
        : requiredString(body.projectId, "Quote projectId", MAX_ID_LENGTH);
  }
  if (body.taxRate !== undefined) {
    update.taxRate = body.taxRate === null ? null : parseTaxRate(body.taxRate);
  }
  if (body.validUntil !== undefined) {
    update.validUntil =
      body.validUntil === null
        ? null
        : requiredString(body.validUntil, "Quote validUntil", MAX_VALID_UNTIL_LENGTH);
  }
  if (body.notes !== undefined) {
    update.notes =
      body.notes === null ? null : requiredString(body.notes, "Quote notes", MAX_NOTES_LENGTH);
  }
  return update;
}
