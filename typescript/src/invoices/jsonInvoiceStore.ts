import { randomUUID } from "node:crypto";
import { promises as fs } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { JsonFileLock } from "../persistence/jsonFileLock.js";
import type { PersistenceWarning } from "../persistence/types.js";
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
  normalizeInvoice,
  requiredText,
} from "./invoiceData.js";

const DOCUMENT_VERSION = 1 as const;

type InvoiceDocument = { version: number; invoices: Invoice[] };

function defaultInvoicesPath(): string {
  const filename = fileURLToPath(import.meta.url);
  return path.resolve(path.dirname(filename), "../../data/jarvis-invoices.json");
}

function isNodeError(error: unknown): error is NodeJS.ErrnoException {
  return error instanceof Error && "code" in error;
}

export class JsonInvoiceStore implements InvoiceStore {
  private readonly writeLock: JsonFileLock;

  constructor(
    private readonly filePath: string = defaultInvoicesPath(),
    warn: PersistenceWarning = () => {},
    lockTimeoutMs = 5000,
  ) {
    this.writeLock = new JsonFileLock(filePath, warn, lockTimeoutMs);
  }

  private async readDocument(): Promise<InvoiceDocument> {
    let raw: string;
    try {
      raw = await fs.readFile(this.filePath, "utf8");
    } catch (error: unknown) {
      if (isNodeError(error) && error.code === "ENOENT")
        return { version: DOCUMENT_VERSION, invoices: [] };
      throw error;
    }
    let parsed: unknown;
    try {
      parsed = JSON.parse(raw);
    } catch {
      await this.setAside();
      return { version: DOCUMENT_VERSION, invoices: [] };
    }
    const rows =
      typeof parsed === "object" &&
      parsed !== null &&
      "invoices" in parsed &&
      Array.isArray((parsed as { invoices: unknown }).invoices)
        ? (parsed as { invoices: unknown[] }).invoices
        : [];
    const invoices: Invoice[] = [];
    for (const row of rows) {
      const invoice = normalizeInvoice(row);
      if (invoice) invoices.push(invoice);
    }
    return { version: DOCUMENT_VERSION, invoices };
  }

  private async setAside(): Promise<void> {
    const corruptPath = `${this.filePath}.corrupt-${Date.now()}-${randomUUID()}`;
    try {
      await fs.rename(this.filePath, corruptPath);
    } catch (error: unknown) {
      if (isNodeError(error) && error.code === "ENOENT") return;
      throw error;
    }
  }

  private async writeDocument(document: InvoiceDocument): Promise<void> {
    await fs.mkdir(path.dirname(this.filePath), { recursive: true });
    const tempPath = path.join(
      path.dirname(this.filePath),
      `.${path.basename(this.filePath)}.tmp-${process.pid}-${randomUUID()}`,
    );
    const handle = await fs.open(tempPath, "w");
    try {
      await handle.writeFile(`${JSON.stringify(document, null, 2)}\n`, "utf8");
    } finally {
      await handle.close();
    }
    await fs.rename(tempPath, this.filePath);
  }

  async list(filter: { clientId?: string; status?: InvoiceStatus } = {}): Promise<Invoice[]> {
    return (await this.readDocument()).invoices
      .filter((invoice) => filter.clientId === undefined || invoice.clientId === filter.clientId)
      .filter((invoice) => filter.status === undefined || invoice.status === filter.status)
      .map(cloneInvoice);
  }

  async get(id: string): Promise<Invoice | null> {
    const invoice = (await this.readDocument()).invoices.find((candidate) => candidate.id === id);
    return invoice ? cloneInvoice(invoice) : null;
  }

  async add(input: InvoiceInput): Promise<Invoice> {
    return this.writeLock.run(async () => {
      const document = await this.readDocument();
      const duplicateKey = input.duplicateKey?.trim();
      if (duplicateKey) {
        const existing = document.invoices.find((invoice) => invoice.duplicateKey === duplicateKey);
        if (existing) return cloneInvoice(existing);
      }
      const invoice = createInvoice(input);
      document.invoices.push(invoice);
      await this.writeDocument(document);
      return cloneInvoice(invoice);
    }, "invoice mutation");
  }

  async update(id: string, update: InvoiceUpdate): Promise<Invoice | null> {
    return this.writeLock.run(async () => {
      const document = await this.readDocument();
      const invoice = document.invoices.find((candidate) => candidate.id === id);
      if (!invoice) return null;
      applyInvoiceUpdate(invoice, update);
      await this.writeDocument(document);
      return cloneInvoice(invoice);
    }, "invoice mutation");
  }

  async issue(id: string): Promise<Invoice | null> {
    return this.writeLock.run(async () => {
      const document = await this.readDocument();
      const invoice = document.invoices.find((candidate) => candidate.id === id);
      if (!invoice) return null;
      if (invoice.status !== "draft") throw new Error("Only draft invoices can be issued.");
      if (invoice.lineItems.length === 0)
        throw new Error("Invoice requires at least one line item.");
      invoice.status = "issued";
      invoice.issuedAt = Date.now();
      invoice.updatedAt = invoice.issuedAt;
      applyInvoiceDerivedFields(invoice);
      await this.writeDocument(document);
      return cloneInvoice(invoice);
    }, "invoice mutation");
  }

  async void(id: string, reason: string): Promise<Invoice | null> {
    return this.writeLock.run(async () => {
      const document = await this.readDocument();
      const invoice = document.invoices.find((candidate) => candidate.id === id);
      if (!invoice) return null;
      if (invoice.status === "void") throw new Error("Invoice is already void.");
      if (invoice.paymentStatus !== "unpaid") {
        throw new Error("Paid or partially paid invoices cannot be voided without adjustment.");
      }
      invoice.status = "void";
      invoice.voidReason = requiredText(reason, "Void reason");
      invoice.voidedAt = Date.now();
      invoice.updatedAt = invoice.voidedAt;
      await this.writeDocument(document);
      return cloneInvoice(invoice);
    }, "invoice mutation");
  }

  async recordPayment(id: string, input: InvoicePaymentInput): Promise<Invoice | null> {
    return this.writeLock.run(async () => {
      const document = await this.readDocument();
      const invoice = document.invoices.find((candidate) => candidate.id === id);
      if (!invoice) return null;
      if (invoice.status !== "issued" && invoice.status !== "paid") {
        throw new Error("Payments can only be recorded against issued invoices.");
      }
      invoice.payments.push(createPayment(input));
      invoice.updatedAt = Date.now();
      applyInvoiceDerivedFields(invoice);
      await this.writeDocument(document);
      return cloneInvoice(invoice);
    }, "invoice mutation");
  }
}
