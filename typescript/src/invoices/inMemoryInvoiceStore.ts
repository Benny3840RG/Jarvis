import type {
  Invoice,
  InvoiceInput,
  InvoicePaymentInput,
  InvoiceStatus,
  InvoiceStore,
  InvoiceUpdate,
} from "./invoice.js";
import {
  applyInvoiceDerivedFields,
  applyInvoiceUpdate,
  cloneInvoice,
  createInvoice,
  createPayment,
  requiredText,
} from "./invoiceData.js";

export class InMemoryInvoiceStore implements InvoiceStore {
  private readonly invoices = new Map<string, Invoice>();

  async list(filter: { clientId?: string; status?: InvoiceStatus } = {}): Promise<Invoice[]> {
    return [...this.invoices.values()]
      .filter((invoice) => filter.clientId === undefined || invoice.clientId === filter.clientId)
      .filter((invoice) => filter.status === undefined || invoice.status === filter.status)
      .map(cloneInvoice);
  }

  async get(id: string): Promise<Invoice | null> {
    const invoice = this.invoices.get(id);
    return invoice ? cloneInvoice(invoice) : null;
  }

  async add(input: InvoiceInput): Promise<Invoice> {
    const duplicateKey = input.duplicateKey?.trim();
    if (duplicateKey) {
      const existing = [...this.invoices.values()].find(
        (invoice) => invoice.duplicateKey === duplicateKey,
      );
      if (existing) return cloneInvoice(existing);
    }
    const invoice = createInvoice(input);
    this.invoices.set(invoice.id, invoice);
    return cloneInvoice(invoice);
  }

  async update(id: string, update: InvoiceUpdate): Promise<Invoice | null> {
    const invoice = this.invoices.get(id);
    if (!invoice) return null;
    applyInvoiceUpdate(invoice, update);
    return cloneInvoice(invoice);
  }

  async issue(id: string): Promise<Invoice | null> {
    const invoice = this.invoices.get(id);
    if (!invoice) return null;
    if (invoice.status !== "draft") throw new Error("Only draft invoices can be issued.");
    if (invoice.lineItems.length === 0) throw new Error("Invoice requires at least one line item.");
    invoice.status = "issued";
    invoice.issuedAt = Date.now();
    invoice.updatedAt = invoice.issuedAt;
    applyInvoiceDerivedFields(invoice);
    return cloneInvoice(invoice);
  }

  async void(id: string, reason: string): Promise<Invoice | null> {
    const invoice = this.invoices.get(id);
    if (!invoice) return null;
    if (invoice.status === "void") throw new Error("Invoice is already void.");
    if (invoice.paymentStatus !== "unpaid") {
      throw new Error("Paid or partially paid invoices cannot be voided without adjustment.");
    }
    invoice.status = "void";
    invoice.voidReason = requiredText(reason, "Void reason");
    invoice.voidedAt = Date.now();
    invoice.updatedAt = invoice.voidedAt;
    return cloneInvoice(invoice);
  }

  async recordPayment(id: string, input: InvoicePaymentInput): Promise<Invoice | null> {
    const invoice = this.invoices.get(id);
    if (!invoice) return null;
    if (invoice.status !== "issued" && invoice.status !== "paid") {
      throw new Error("Payments can only be recorded against issued invoices.");
    }
    invoice.payments.push(createPayment(input));
    invoice.updatedAt = Date.now();
    applyInvoiceDerivedFields(invoice);
    return cloneInvoice(invoice);
  }
}
