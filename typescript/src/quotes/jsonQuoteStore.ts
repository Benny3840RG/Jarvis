import { randomUUID } from "node:crypto";
import { promises as fs } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { JsonFileLock } from "../persistence/jsonFileLock.js";
import type { PersistenceWarning } from "../persistence/types.js";
import { applyQuoteUpdate, cloneQuote, createQuote, normalizeLineItems } from "./quoteData.js";
import {
  computeQuoteTotals,
  isQuoteStatus,
  type Quote,
  type QuoteInput,
  type QuoteStatus,
  type QuoteStore,
  type QuoteUpdate,
} from "./quote.js";

const DOCUMENT_VERSION = 1 as const;

type QuoteDocument = { version: number; quotes: Quote[] };

function defaultQuotesPath(): string {
  const filename = fileURLToPath(import.meta.url);
  return path.resolve(path.dirname(filename), "../../data/jarvis-quotes.json");
}

function isNodeError(error: unknown): error is NodeJS.ErrnoException {
  return error instanceof Error && "code" in error;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/**
 * Rebuilds a stored quote, re-deriving its totals so persisted numbers can never
 * drift from the line items they are computed from.
 */
function normalizeQuote(value: unknown): Quote | null {
  if (!isRecord(value)) return null;
  if (
    typeof value.id !== "string" ||
    typeof value.clientId !== "string" ||
    typeof value.number !== "string"
  ) {
    return null;
  }
  let lineItems;
  try {
    lineItems = normalizeLineItems(value.lineItems ?? []);
  } catch {
    return null;
  }
  const status: QuoteStatus = isQuoteStatus(value.status) ? value.status : "draft";
  const taxRate =
    typeof value.taxRate === "number" && value.taxRate >= 0 && value.taxRate <= 1
      ? value.taxRate
      : undefined;
  const totals = computeQuoteTotals(lineItems, taxRate);
  const createdAt = typeof value.createdAt === "number" ? value.createdAt : Date.now();
  return {
    id: value.id,
    clientId: value.clientId,
    ...(typeof value.projectId === "string" && value.projectId.trim()
      ? { projectId: value.projectId }
      : {}),
    number: value.number,
    status,
    lineItems,
    subtotal: totals.subtotal,
    ...(taxRate === undefined ? {} : { taxRate }),
    tax: totals.tax,
    total: totals.total,
    ...(typeof value.validUntil === "string" && value.validUntil.trim()
      ? { validUntil: value.validUntil }
      : {}),
    ...(typeof value.notes === "string" && value.notes.trim() ? { notes: value.notes } : {}),
    createdAt,
    updatedAt: typeof value.updatedAt === "number" ? value.updatedAt : createdAt,
  };
}

export class JsonQuoteStore implements QuoteStore {
  private readonly writeLock: JsonFileLock;

  constructor(
    private readonly filePath: string = defaultQuotesPath(),
    warn: PersistenceWarning = () => {},
    lockTimeoutMs = 5000,
  ) {
    this.writeLock = new JsonFileLock(filePath, warn, lockTimeoutMs);
  }

  private async readDocument(): Promise<QuoteDocument> {
    let raw: string;
    try {
      raw = await fs.readFile(this.filePath, "utf8");
    } catch (error: unknown) {
      if (isNodeError(error) && error.code === "ENOENT")
        return { version: DOCUMENT_VERSION, quotes: [] };
      throw error;
    }
    let parsed: unknown;
    try {
      parsed = JSON.parse(raw);
    } catch {
      await this.setAside();
      return { version: DOCUMENT_VERSION, quotes: [] };
    }
    const quotesValue = isRecord(parsed) ? parsed.quotes : undefined;
    const rows = Array.isArray(quotesValue) ? quotesValue : [];
    const quotes: Quote[] = [];
    for (const row of rows) {
      const quote = normalizeQuote(row);
      if (quote) quotes.push(quote);
    }
    return { version: DOCUMENT_VERSION, quotes };
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

  private async writeDocument(document: QuoteDocument): Promise<void> {
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

  async list(): Promise<Quote[]> {
    return (await this.readDocument()).quotes.map(cloneQuote);
  }

  async get(id: string): Promise<Quote | null> {
    const quote = (await this.readDocument()).quotes.find((candidate) => candidate.id === id);
    return quote ? cloneQuote(quote) : null;
  }

  async add(input: QuoteInput): Promise<Quote> {
    return this.writeLock.run(async () => {
      const document = await this.readDocument();
      const quote = createQuote(input);
      document.quotes.push(quote);
      await this.writeDocument(document);
      return cloneQuote(quote);
    }, "quote mutation");
  }

  async update(id: string, update: QuoteUpdate): Promise<Quote | null> {
    return this.writeLock.run(async () => {
      const document = await this.readDocument();
      const quote = document.quotes.find((candidate) => candidate.id === id);
      if (!quote) return null;
      applyQuoteUpdate(quote, update);
      await this.writeDocument(document);
      return cloneQuote(quote);
    }, "quote mutation");
  }

  async remove(id: string): Promise<Quote | null> {
    return this.writeLock.run(async () => {
      const document = await this.readDocument();
      const index = document.quotes.findIndex((candidate) => candidate.id === id);
      if (index === -1) return null;
      const [removed] = document.quotes.splice(index, 1);
      await this.writeDocument(document);
      return cloneQuote(removed);
    }, "quote mutation");
  }
}
