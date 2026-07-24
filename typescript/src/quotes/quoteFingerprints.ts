import { createHash } from "node:crypto";

import type { QuoteRevisionLineItem } from "./quoteLifecycle.js";

export type QuoteRevisionFingerprintInput = {
  ownerId: string;
  quoteId: string;
  revision: number;
  clientId: string;
  projectId?: string;
  number: string;
  lineItems: QuoteRevisionLineItem[];
  subtotal: number;
  taxRate?: number;
  tax: number;
  total: number;
  currency: "AUD";
  validUntil?: string;
  notes?: string;
  termsIncluded: boolean;
};

export type QuoteSendFingerprintInput = {
  ownerId: string;
  quoteId: string;
  revision: number;
  revisionFingerprint: string;
  recipient: string;
  channel: "email";
};

export class QuoteRecipientInvalidError extends Error {
  constructor(message = "The quote recipient must be a valid email address.") {
    super(message);
    this.name = "QuoteRecipientInvalidError";
  }
}

function canonicalize(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(canonicalize);
  if (value === null || typeof value !== "object") return value;

  const result: Record<string, unknown> = {};
  for (const key of Object.keys(value).sort()) {
    const entry = (value as Record<string, unknown>)[key];
    if (entry !== undefined) result[key] = canonicalize(entry);
  }
  return result;
}

function digest(prefix: string, value: unknown): string {
  const canonicalJson = JSON.stringify(canonicalize(value));
  return `${prefix}${createHash("sha256").update(canonicalJson).digest("hex")}`;
}

export function normalizeQuoteRecipient(value: string): string {
  const normalized = value.trim().toLowerCase();
  if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(normalized)) {
    throw new QuoteRecipientInvalidError();
  }
  return normalized;
}

export function quoteRevisionFingerprint(input: QuoteRevisionFingerprintInput): string {
  return digest("quote-revision:v1:sha256:", {
    ownerId: input.ownerId,
    quoteId: input.quoteId,
    revision: input.revision,
    clientId: input.clientId,
    projectId: input.projectId,
    number: input.number,
    lineItems: input.lineItems,
    subtotal: input.subtotal,
    taxRate: input.taxRate,
    tax: input.tax,
    total: input.total,
    currency: input.currency,
    validUntil: input.validUntil,
    notes: input.notes,
    termsIncluded: input.termsIncluded,
  });
}

export function quoteSendFingerprint(input: QuoteSendFingerprintInput): string {
  return digest("quote-send:v1:sha256:", {
    ownerId: input.ownerId,
    quoteId: input.quoteId,
    revision: input.revision,
    revisionFingerprint: input.revisionFingerprint,
    normalizedRecipient: normalizeQuoteRecipient(input.recipient),
    channel: input.channel,
  });
}
