export type InvoiceStatus = "draft" | "issued" | "paid" | "void";
export type InvoicePaymentStatus = "unpaid" | "partial" | "paid" | "overpaid";

export const INVOICE_STATUSES: readonly InvoiceStatus[] = ["draft", "issued", "paid", "void"];

export interface InvoiceLineItem {
  description: string;
  quantity: number;
  unitPrice: number;
}

export interface InvoicePayment {
  id: string;
  amount: number;
  receivedAt: number;
  method?: string;
  reference?: string;
  notes?: string;
  createdAt: number;
}

export interface Invoice {
  id: string;
  clientId: string;
  projectId?: string;
  quoteId?: string;
  number: string;
  status: InvoiceStatus;
  lineItems: InvoiceLineItem[];
  subtotal: number;
  taxRate?: number;
  tax: number;
  total: number;
  amountPaid: number;
  balanceDue: number;
  paymentStatus: InvoicePaymentStatus;
  dueDate?: string;
  notes?: string;
  duplicateKey?: string;
  payments: InvoicePayment[];
  issuedAt?: number;
  voidedAt?: number;
  voidReason?: string;
  createdAt: number;
  updatedAt: number;
}

export interface InvoiceInput {
  clientId: string;
  projectId?: string;
  quoteId?: string;
  number: string;
  lineItems?: InvoiceLineItem[];
  taxRate?: number;
  dueDate?: string;
  notes?: string;
  duplicateKey?: string;
}

export interface InvoiceUpdate {
  projectId?: string | null;
  quoteId?: string | null;
  number?: string;
  lineItems?: InvoiceLineItem[];
  taxRate?: number | null;
  dueDate?: string | null;
  notes?: string | null;
}

export interface InvoicePaymentInput {
  amount: number;
  receivedAt?: number;
  method?: string;
  reference?: string;
  notes?: string;
}

export interface InvoiceStore {
  list(filter?: { clientId?: string; status?: InvoiceStatus }): Promise<Invoice[]>;
  get(id: string): Promise<Invoice | null>;
  add(input: InvoiceInput): Promise<Invoice>;
  update(id: string, update: InvoiceUpdate): Promise<Invoice | null>;
  issue(id: string): Promise<Invoice | null>;
  void(id: string, reason: string): Promise<Invoice | null>;
  recordPayment(id: string, input: InvoicePaymentInput): Promise<Invoice | null>;
}

export function isInvoiceStatus(value: unknown): value is InvoiceStatus {
  return typeof value === "string" && (INVOICE_STATUSES as readonly string[]).includes(value);
}

/** Rounds to whole cents to keep currency arithmetic exact. */
export function roundMoney(value: number): number {
  return Math.round((value + Number.EPSILON) * 100) / 100;
}

export function computeInvoiceTotals(
  lineItems: InvoiceLineItem[],
  taxRate?: number,
): { subtotal: number; tax: number; total: number } {
  const subtotal = roundMoney(
    lineItems.reduce((sum, item) => sum + item.quantity * item.unitPrice, 0),
  );
  const tax = taxRate === undefined ? 0 : roundMoney(subtotal * taxRate);
  return { subtotal, tax, total: roundMoney(subtotal + tax) };
}
