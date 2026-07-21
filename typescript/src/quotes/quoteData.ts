import { randomUUID } from "node:crypto";

import {
  computeQuoteTotals,
  type Quote,
  type QuoteInput,
  type QuoteLineItem,
  type QuoteUpdate,
} from "./quote.js";

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

export function requiredText(value: unknown, field: string): string {
  if (typeof value !== "string" || value.trim().length === 0) {
    throw new Error(`${field} cannot be empty.`);
  }
  return value.trim();
}

function nonNegativeNumber(value: unknown, field: string): number {
  if (typeof value !== "number" || !Number.isFinite(value) || value < 0) {
    throw new Error(`${field} must be a non-negative number.`);
  }
  return value;
}

function validTaxRate(value: unknown): number {
  if (typeof value !== "number" || !Number.isFinite(value) || value < 0 || value > 1) {
    throw new Error("Quote taxRate must be a number between 0 and 1.");
  }
  return value;
}

export function normalizeLineItems(value: unknown): QuoteLineItem[] {
  if (!Array.isArray(value)) throw new Error("Quote lineItems must be an array.");
  return value.map((entry, index) => {
    if (!isRecord(entry)) throw new Error(`Line item ${index + 1} must be an object.`);
    return {
      description: requiredText(entry.description, `Line item ${index + 1} description`),
      quantity: nonNegativeNumber(entry.quantity, `Line item ${index + 1} quantity`),
      unitPrice: nonNegativeNumber(entry.unitPrice, `Line item ${index + 1} unitPrice`),
    };
  });
}

export function cloneQuote(quote: Quote): Quote {
  return { ...quote, lineItems: quote.lineItems.map((item) => ({ ...item })) };
}

function applyTotals(quote: Quote): void {
  const totals = computeQuoteTotals(quote.lineItems, quote.taxRate);
  quote.subtotal = totals.subtotal;
  quote.tax = totals.tax;
  quote.total = totals.total;
}

/** Builds a fully-formed quote from input, with server-derived totals. */
export function createQuote(input: QuoteInput): Quote {
  const now = Date.now();
  const lineItems = normalizeLineItems(input.lineItems ?? []);
  const taxRate = input.taxRate === undefined ? undefined : validTaxRate(input.taxRate);
  const totals = computeQuoteTotals(lineItems, taxRate);
  return {
    id: randomUUID(),
    clientId: requiredText(input.clientId, "Quote clientId"),
    ...(input.projectId && input.projectId.trim() ? { projectId: input.projectId.trim() } : {}),
    number: requiredText(input.number, "Quote number"),
    status: input.status ?? "draft",
    lineItems,
    subtotal: totals.subtotal,
    ...(taxRate === undefined ? {} : { taxRate }),
    tax: totals.tax,
    total: totals.total,
    ...(input.validUntil && input.validUntil.trim() ? { validUntil: input.validUntil.trim() } : {}),
    ...(input.notes && input.notes.trim() ? { notes: input.notes.trim() } : {}),
    createdAt: now,
    updatedAt: now,
  };
}

function setOrClear(
  quote: Quote,
  key: "projectId" | "validUntil" | "notes",
  value: string | null,
): void {
  const cleaned = value === null ? "" : value.trim();
  if (cleaned) quote[key] = cleaned;
  else delete quote[key];
}

/** Applies an update in place, recomputing totals from the resulting line items. */
export function applyQuoteUpdate(quote: Quote, update: QuoteUpdate): void {
  if (Object.values(update).every((value) => value === undefined)) {
    throw new Error("Quote update requires at least one changed field.");
  }
  if (update.clientId !== undefined)
    quote.clientId = requiredText(update.clientId, "Quote clientId");
  if (update.number !== undefined) quote.number = requiredText(update.number, "Quote number");
  if (update.status !== undefined) quote.status = update.status;
  if (update.lineItems !== undefined) quote.lineItems = normalizeLineItems(update.lineItems);
  if (update.taxRate !== undefined) {
    if (update.taxRate === null) delete quote.taxRate;
    else quote.taxRate = validTaxRate(update.taxRate);
  }
  if (update.projectId !== undefined) setOrClear(quote, "projectId", update.projectId);
  if (update.validUntil !== undefined) setOrClear(quote, "validUntil", update.validUntil);
  if (update.notes !== undefined) setOrClear(quote, "notes", update.notes);
  applyTotals(quote);
  quote.updatedAt = Date.now();
}
