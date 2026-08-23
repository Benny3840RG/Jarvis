import {
  INVOICE_STATUSES,
  isInvoiceStatus,
  type InvoiceInput,
  type InvoicePaymentInput,
  type InvoiceStatus,
  type InvoiceUpdate,
} from "../invoices/invoice.js";

const MAX_ID_LENGTH = 200;
const MAX_TEXT_LENGTH = 2000;
const MAX_SHORT_TEXT_LENGTH = 500;
const MAX_LINE_ITEMS = 200;

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function rejectUnknownKeys(body: Record<string, unknown>, allowed: readonly string[]): void {
  if (Object.keys(body).some((key) => !allowed.includes(key))) {
    throw new Error("Request contains unsupported fields.");
  }
}

function requiredString(value: unknown, field: string, max: number): string {
  if (typeof value !== "string" || value.trim().length === 0) {
    throw new Error(`${field} must be a non-empty string.`);
  }
  if (value.trim().length > max) throw new Error(`${field} must not exceed ${max} characters.`);
  return value.trim();
}

function nullableString(value: unknown, field: string, max: number): string | null {
  return value === null ? null : requiredString(value, field, max);
}

function nonNegativeNumber(value: unknown, field: string): number {
  if (typeof value !== "number" || !Number.isFinite(value) || value < 0) {
    throw new Error(`${field} must be a non-negative number.`);
  }
  return value;
}

function positiveNumber(value: unknown, field: string): number {
  if (typeof value !== "number" || !Number.isFinite(value) || value <= 0) {
    throw new Error(`${field} must be a positive number.`);
  }
  return value;
}

function taxRate(value: unknown): number {
  if (typeof value !== "number" || !Number.isFinite(value) || value < 0 || value > 1) {
    throw new Error("Invoice taxRate must be a number between 0 and 1.");
  }
  return value;
}

function parseLineItems(value: unknown) {
  if (!Array.isArray(value)) throw new Error("Invoice lineItems must be an array.");
  if (value.length > MAX_LINE_ITEMS) throw new Error(`No more than ${MAX_LINE_ITEMS} line items.`);
  return value.map((entry, index) => {
    if (!isRecord(entry)) throw new Error(`Line item ${index + 1} must be an object.`);
    rejectUnknownKeys(entry, ["description", "quantity", "unitPrice"]);
    return {
      description: requiredString(
        entry.description,
        `Line item ${index + 1} description`,
        MAX_SHORT_TEXT_LENGTH,
      ),
      quantity: nonNegativeNumber(entry.quantity, `Line item ${index + 1} quantity`),
      unitPrice: nonNegativeNumber(entry.unitPrice, `Line item ${index + 1} unitPrice`),
    };
  });
}

export function parseInvoiceStatus(value: unknown): InvoiceStatus | undefined {
  if (value === undefined) return undefined;
  if (!isInvoiceStatus(value)) {
    throw new Error(`Invoice status must be one of: ${INVOICE_STATUSES.join(", ")}.`);
  }
  return value;
}

export function parseCreateInvoice(body: unknown): InvoiceInput {
  if (!isRecord(body)) throw new Error("Request body must be a JSON object.");
  rejectUnknownKeys(body, [
    "clientId",
    "projectId",
    "quoteId",
    "number",
    "lineItems",
    "taxRate",
    "dueDate",
    "notes",
    "duplicateKey",
  ]);
  return {
    clientId: requiredString(body.clientId, "Invoice clientId", MAX_ID_LENGTH),
    number: requiredString(body.number, "Invoice number", MAX_ID_LENGTH),
    ...(body.projectId === undefined
      ? {}
      : { projectId: requiredString(body.projectId, "Invoice projectId", MAX_ID_LENGTH) }),
    ...(body.quoteId === undefined
      ? {}
      : { quoteId: requiredString(body.quoteId, "Invoice quoteId", MAX_ID_LENGTH) }),
    ...(body.lineItems === undefined ? {} : { lineItems: parseLineItems(body.lineItems) }),
    ...(body.taxRate === undefined ? {} : { taxRate: taxRate(body.taxRate) }),
    ...(body.dueDate === undefined
      ? {}
      : { dueDate: requiredString(body.dueDate, "Invoice dueDate", MAX_SHORT_TEXT_LENGTH) }),
    ...(body.notes === undefined
      ? {}
      : { notes: requiredString(body.notes, "Invoice notes", MAX_TEXT_LENGTH) }),
    ...(body.duplicateKey === undefined
      ? {}
      : { duplicateKey: requiredString(body.duplicateKey, "Duplicate key", MAX_ID_LENGTH) }),
  };
}

export function parseUpdateInvoice(body: unknown): InvoiceUpdate {
  if (!isRecord(body)) throw new Error("Request body must be a JSON object.");
  rejectUnknownKeys(body, [
    "projectId",
    "quoteId",
    "number",
    "lineItems",
    "taxRate",
    "dueDate",
    "notes",
  ]);
  if (Object.keys(body).length === 0) {
    throw new Error("Invoice update requires at least one changed field.");
  }
  const update: InvoiceUpdate = {};
  if (body.projectId !== undefined)
    update.projectId = nullableString(body.projectId, "Invoice projectId", MAX_ID_LENGTH);
  if (body.quoteId !== undefined)
    update.quoteId = nullableString(body.quoteId, "Invoice quoteId", MAX_ID_LENGTH);
  if (body.number !== undefined)
    update.number = requiredString(body.number, "Invoice number", MAX_ID_LENGTH);
  if (body.lineItems !== undefined) update.lineItems = parseLineItems(body.lineItems);
  if (body.taxRate !== undefined)
    update.taxRate = body.taxRate === null ? null : taxRate(body.taxRate);
  if (body.dueDate !== undefined)
    update.dueDate = nullableString(body.dueDate, "Invoice dueDate", MAX_SHORT_TEXT_LENGTH);
  if (body.notes !== undefined)
    update.notes = nullableString(body.notes, "Invoice notes", MAX_TEXT_LENGTH);
  return update;
}

export function parseVoidInvoice(body: unknown): string {
  if (!isRecord(body)) throw new Error("Request body must be a JSON object.");
  rejectUnknownKeys(body, ["reason"]);
  return requiredString(body.reason, "Void reason", MAX_TEXT_LENGTH);
}

export function parseInvoicePayment(body: unknown): InvoicePaymentInput {
  if (!isRecord(body)) throw new Error("Request body must be a JSON object.");
  rejectUnknownKeys(body, ["amount", "receivedAt", "method", "reference", "notes"]);
  return {
    amount: positiveNumber(body.amount, "Payment amount"),
    ...(body.receivedAt === undefined
      ? {}
      : { receivedAt: nonNegativeNumber(body.receivedAt, "Payment receivedAt") }),
    ...(body.method === undefined
      ? {}
      : { method: requiredString(body.method, "Payment method", MAX_SHORT_TEXT_LENGTH) }),
    ...(body.reference === undefined
      ? {}
      : { reference: requiredString(body.reference, "Payment reference", MAX_SHORT_TEXT_LENGTH) }),
    ...(body.notes === undefined
      ? {}
      : { notes: requiredString(body.notes, "Payment notes", MAX_TEXT_LENGTH) }),
  };
}
