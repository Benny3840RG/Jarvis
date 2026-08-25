import { randomUUID } from "node:crypto";

import {
  computeInvoiceTotals,
  type Invoice,
  type InvoiceInput,
  type InvoiceLineItem,
  type InvoicePayment,
  type InvoicePaymentInput,
  type InvoicePaymentStatus,
  type InvoiceUpdate,
} from "./invoice.js";
import { isInvoiceStatus } from "./invoice.js";

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

export function requiredText(value: unknown, field: string): string {
  if (typeof value !== "string" || value.trim().length === 0) {
    throw new Error(`${field} cannot be empty.`);
  }
  return value.trim();
}

export function optionalText(value: unknown): string | undefined {
  return typeof value === "string" && value.trim() ? value.trim() : undefined;
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

function validTaxRate(value: unknown): number {
  if (typeof value !== "number" || !Number.isFinite(value) || value < 0 || value > 1) {
    throw new Error("Invoice taxRate must be a number between 0 and 1.");
  }
  return value;
}

export function normalizeLineItems(value: unknown): InvoiceLineItem[] {
  if (!Array.isArray(value)) throw new Error("Invoice lineItems must be an array.");
  return value.map((entry, index) => {
    if (!isRecord(entry)) throw new Error(`Line item ${index + 1} must be an object.`);
    return {
      description: requiredText(entry.description, `Line item ${index + 1} description`),
      quantity: nonNegativeNumber(entry.quantity, `Line item ${index + 1} quantity`),
      unitPrice: nonNegativeNumber(entry.unitPrice, `Line item ${index + 1} unitPrice`),
    };
  });
}

function normalizePayment(value: unknown): InvoicePayment | null {
  if (!isRecord(value) || typeof value.id !== "string" || typeof value.amount !== "number") {
    return null;
  }
  const receivedAt = typeof value.receivedAt === "number" ? value.receivedAt : Date.now();
  const createdAt = typeof value.createdAt === "number" ? value.createdAt : receivedAt;
  return {
    id: value.id,
    amount: positiveNumber(value.amount, "Payment amount"),
    receivedAt,
    ...(optionalText(value.method) === undefined ? {} : { method: optionalText(value.method) }),
    ...(optionalText(value.reference) === undefined
      ? {}
      : { reference: optionalText(value.reference) }),
    ...(optionalText(value.notes) === undefined ? {} : { notes: optionalText(value.notes) }),
    createdAt,
  };
}

export function cloneInvoice(invoice: Invoice): Invoice {
  return {
    ...invoice,
    lineItems: invoice.lineItems.map((item) => ({ ...item })),
    payments: invoice.payments.map((payment) => ({ ...payment })),
  };
}

function derivePaymentStatus(total: number, amountPaid: number): InvoicePaymentStatus {
  if (amountPaid === 0) return "unpaid";
  if (amountPaid < total) return "partial";
  if (amountPaid === total) return "paid";
  return "overpaid";
}

export function applyInvoiceDerivedFields(invoice: Invoice): void {
  const totals = computeInvoiceTotals(invoice.lineItems, invoice.taxRate);
  invoice.subtotal = totals.subtotal;
  invoice.tax = totals.tax;
  invoice.total = totals.total;
  invoice.amountPaid = invoice.payments.reduce((sum, payment) => sum + payment.amount, 0);
  invoice.balanceDue =
    Math.round((invoice.total - invoice.amountPaid + Number.EPSILON) * 100) / 100;
  invoice.paymentStatus = derivePaymentStatus(invoice.total, invoice.amountPaid);
  if (invoice.status !== "void" && invoice.paymentStatus === "paid") invoice.status = "paid";
  if (invoice.status === "paid" && invoice.paymentStatus !== "paid") invoice.status = "issued";
}

export function normalizeInvoice(value: unknown): Invoice | null {
  if (!isRecord(value) || typeof value.id !== "string" || typeof value.clientId !== "string") {
    return null;
  }
  if (typeof value.number !== "string") return null;
  const createdAt = typeof value.createdAt === "number" ? value.createdAt : Date.now();
  const taxRate =
    typeof value.taxRate === "number" && value.taxRate >= 0 && value.taxRate <= 1
      ? value.taxRate
      : undefined;
  const invoice: Invoice = {
    id: value.id,
    clientId: requiredText(value.clientId, "Invoice clientId"),
    ...(optionalText(value.projectId) === undefined
      ? {}
      : { projectId: optionalText(value.projectId) }),
    ...(optionalText(value.quoteId) === undefined ? {} : { quoteId: optionalText(value.quoteId) }),
    number: requiredText(value.number, "Invoice number"),
    status: isInvoiceStatus(value.status) ? value.status : "draft",
    lineItems: normalizeLineItems(value.lineItems ?? []),
    subtotal: 0,
    ...(taxRate === undefined ? {} : { taxRate }),
    tax: 0,
    total: 0,
    amountPaid: 0,
    balanceDue: 0,
    paymentStatus: "unpaid",
    ...(optionalText(value.dueDate) === undefined ? {} : { dueDate: optionalText(value.dueDate) }),
    ...(optionalText(value.notes) === undefined ? {} : { notes: optionalText(value.notes) }),
    ...(optionalText(value.duplicateKey) === undefined
      ? {}
      : { duplicateKey: optionalText(value.duplicateKey) }),
    payments: Array.isArray(value.payments)
      ? value.payments.flatMap((payment) => {
          const normalized = normalizePayment(payment);
          return normalized ? [normalized] : [];
        })
      : [],
    ...(typeof value.issuedAt === "number" ? { issuedAt: value.issuedAt } : {}),
    ...(typeof value.voidedAt === "number" ? { voidedAt: value.voidedAt } : {}),
    ...(optionalText(value.voidReason) === undefined
      ? {}
      : { voidReason: optionalText(value.voidReason) }),
    createdAt,
    updatedAt: typeof value.updatedAt === "number" ? value.updatedAt : createdAt,
  };
  applyInvoiceDerivedFields(invoice);
  return invoice;
}

export function createInvoice(input: InvoiceInput): Invoice {
  const now = Date.now();
  const lineItems = normalizeLineItems(input.lineItems ?? []);
  const taxRate = input.taxRate === undefined ? undefined : validTaxRate(input.taxRate);
  const invoice: Invoice = {
    id: randomUUID(),
    clientId: requiredText(input.clientId, "Invoice clientId"),
    ...(optionalText(input.projectId) === undefined
      ? {}
      : { projectId: optionalText(input.projectId) }),
    ...(optionalText(input.quoteId) === undefined ? {} : { quoteId: optionalText(input.quoteId) }),
    number: requiredText(input.number, "Invoice number"),
    status: "draft",
    lineItems,
    subtotal: 0,
    ...(taxRate === undefined ? {} : { taxRate }),
    tax: 0,
    total: 0,
    amountPaid: 0,
    balanceDue: 0,
    paymentStatus: "unpaid",
    ...(optionalText(input.dueDate) === undefined ? {} : { dueDate: optionalText(input.dueDate) }),
    ...(optionalText(input.notes) === undefined ? {} : { notes: optionalText(input.notes) }),
    ...(optionalText(input.duplicateKey) === undefined
      ? {}
      : { duplicateKey: optionalText(input.duplicateKey) }),
    payments: [],
    createdAt: now,
    updatedAt: now,
  };
  applyInvoiceDerivedFields(invoice);
  return invoice;
}

function setOrClear(
  invoice: Invoice,
  key: "projectId" | "quoteId" | "dueDate" | "notes",
  value: string | null,
): void {
  const cleaned = value === null ? "" : value.trim();
  if (cleaned) invoice[key] = cleaned;
  else delete invoice[key];
}

export function applyInvoiceUpdate(invoice: Invoice, update: InvoiceUpdate): void {
  if (Object.values(update).every((value) => value === undefined)) {
    throw new Error("Invoice update requires at least one changed field.");
  }
  if (invoice.status !== "draft") throw new Error("Only draft invoices can be updated.");
  if (update.number !== undefined) invoice.number = requiredText(update.number, "Invoice number");
  if (update.lineItems !== undefined) invoice.lineItems = normalizeLineItems(update.lineItems);
  if (update.taxRate !== undefined) {
    if (update.taxRate === null) delete invoice.taxRate;
    else invoice.taxRate = validTaxRate(update.taxRate);
  }
  if (update.projectId !== undefined) setOrClear(invoice, "projectId", update.projectId);
  if (update.quoteId !== undefined) setOrClear(invoice, "quoteId", update.quoteId);
  if (update.dueDate !== undefined) setOrClear(invoice, "dueDate", update.dueDate);
  if (update.notes !== undefined) setOrClear(invoice, "notes", update.notes);
  invoice.updatedAt = Date.now();
  applyInvoiceDerivedFields(invoice);
}

export function createPayment(input: InvoicePaymentInput): InvoicePayment {
  const now = Date.now();
  return {
    id: randomUUID(),
    amount: positiveNumber(input.amount, "Payment amount"),
    receivedAt: input.receivedAt ?? now,
    ...(optionalText(input.method) === undefined ? {} : { method: optionalText(input.method) }),
    ...(optionalText(input.reference) === undefined
      ? {}
      : { reference: optionalText(input.reference) }),
    ...(optionalText(input.notes) === undefined ? {} : { notes: optionalText(input.notes) }),
    createdAt: now,
  };
}
