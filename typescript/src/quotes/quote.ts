export type QuoteStatus = "draft" | "sent" | "accepted" | "declined";

export const QUOTE_STATUSES: readonly QuoteStatus[] = ["draft", "sent", "accepted", "declined"];

export interface QuoteLineItem {
  description: string;
  quantity: number;
  unitPrice: number;
}

export interface Quote {
  id: string;
  clientId: string;
  projectId?: string;
  number: string;
  status: QuoteStatus;
  lineItems: QuoteLineItem[];
  subtotal: number;
  taxRate?: number;
  tax: number;
  total: number;
  validUntil?: string;
  notes?: string;
  createdAt: number;
  updatedAt: number;
}

export interface QuoteInput {
  clientId: string;
  number: string;
  projectId?: string;
  status?: QuoteStatus;
  lineItems?: QuoteLineItem[];
  taxRate?: number;
  validUntil?: string;
  notes?: string;
}

export interface QuoteUpdate {
  clientId?: string;
  projectId?: string | null;
  number?: string;
  status?: QuoteStatus;
  lineItems?: QuoteLineItem[];
  taxRate?: number | null;
  validUntil?: string | null;
  notes?: string | null;
}

export function isQuoteStatus(value: unknown): value is QuoteStatus {
  return typeof value === "string" && (QUOTE_STATUSES as readonly string[]).includes(value);
}

/** Rounds to whole cents to keep currency arithmetic exact. */
export function roundMoney(value: number): number {
  return Math.round((value + Number.EPSILON) * 100) / 100;
}

export type QuoteTotals = { subtotal: number; tax: number; total: number };

/**
 * Computes quote totals from its line items and optional tax rate. Totals are
 * always derived here and never trusted from client input, so a quote's numbers
 * cannot drift from its line items.
 */
export function computeQuoteTotals(lineItems: QuoteLineItem[], taxRate?: number): QuoteTotals {
  const subtotal = roundMoney(
    lineItems.reduce((sum, item) => sum + item.quantity * item.unitPrice, 0),
  );
  const tax = taxRate === undefined ? 0 : roundMoney(subtotal * taxRate);
  return { subtotal, tax, total: roundMoney(subtotal + tax) };
}

/** Durable store for quotes; a separate store like clients and projects. */
export interface QuoteStore {
  list(): Promise<Quote[]>;
  get(id: string): Promise<Quote | null>;
  add(input: QuoteInput): Promise<Quote>;
  update(id: string, update: QuoteUpdate): Promise<Quote | null>;
  remove(id: string): Promise<Quote | null>;
}
