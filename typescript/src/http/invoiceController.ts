import { createHash } from "node:crypto";

import {
  Body,
  Controller,
  Get,
  HttpCode,
  HttpStatus,
  Inject,
  Param,
  Patch,
  Post,
  Query,
  Req,
} from "@nestjs/common";
import type { FastifyRequest } from "fastify";

import type { Invoice, InvoiceStore } from "../invoices/invoice.js";
import {
  parseCreateInvoice,
  parseInvoicePayment,
  parseInvoiceStatus,
  parseUpdateInvoice,
  parseVoidInvoice,
} from "./invoiceRequest.js";
import { JarvisProblem } from "./problemDetails.js";
import { parseIdempotencyKey } from "./taskRequest.js";
import { HTTP_INVOICE_STORE } from "./tokens.js";

type CachedPayment = { fingerprint: string; invoice: Invoice };
type PendingPayment = { fingerprint: string; invoice: Promise<Invoice | null> };
const IDEMPOTENCY_CACHE_LIMIT = 1_000;

function invalid(detail: string): JarvisProblem {
  return new JarvisProblem(
    HttpStatus.UNPROCESSABLE_ENTITY,
    "invalid-invoice",
    "Invalid Invoice",
    detail,
  );
}

function notFound(): JarvisProblem {
  return new JarvisProblem(
    HttpStatus.NOT_FOUND,
    "invoice-not-found",
    "Invoice Not Found",
    "The requested invoice does not exist.",
  );
}

function operationFailed(): JarvisProblem {
  return new JarvisProblem(
    HttpStatus.SERVICE_UNAVAILABLE,
    "invoice-persistence-failed",
    "Invoice Operation Failed",
    "The configured invoice store could not complete the operation.",
  );
}

function invoiceResponse(invoice: Invoice): { data: Invoice } {
  return { data: invoice };
}

function isInvalidInvoiceError(error: unknown): error is Error {
  return (
    error instanceof Error &&
    /draft|issued|void|paid|payment|empty|requires|must be|must not|line item/i.test(error.message)
  );
}

function requestFingerprint(input: unknown): string {
  return createHash("sha256").update(JSON.stringify(input), "utf8").digest("hex");
}

@Controller("api/v1/invoices")
export class InvoiceController {
  private readonly cachedPayments = new Map<string, CachedPayment>();
  private readonly pendingPayments = new Map<string, PendingPayment>();

  constructor(@Inject(HTTP_INVOICE_STORE) private readonly invoices: InvoiceStore) {}

  @Get()
  async list(@Query("clientId") clientId?: string, @Query("status") status?: string) {
    const parsedStatus = (() => {
      try {
        return parseInvoiceStatus(status);
      } catch (error: unknown) {
        throw invalid(error instanceof Error ? error.message : "The invoice filter is invalid.");
      }
    })();
    try {
      const data = await this.invoices.list({
        ...(typeof clientId === "string" && clientId.trim() ? { clientId: clientId.trim() } : {}),
        ...(parsedStatus === undefined ? {} : { status: parsedStatus }),
      });
      return { data, count: data.length };
    } catch {
      throw operationFailed();
    }
  }

  @Post()
  @HttpCode(HttpStatus.CREATED)
  async create(@Body() body: unknown) {
    const input = (() => {
      try {
        return parseCreateInvoice(body);
      } catch (error: unknown) {
        throw invalid(error instanceof Error ? error.message : "The invoice request is invalid.");
      }
    })();
    try {
      return invoiceResponse(await this.invoices.add(input));
    } catch (error: unknown) {
      if (isInvalidInvoiceError(error)) throw invalid(error.message);
      throw operationFailed();
    }
  }

  @Get(":invoiceId")
  async get(@Param("invoiceId") invoiceId: string) {
    let invoice: Invoice | null;
    try {
      invoice = await this.invoices.get(invoiceId);
    } catch {
      throw operationFailed();
    }
    if (!invoice) throw notFound();
    return invoiceResponse(invoice);
  }

  @Patch(":invoiceId")
  async update(@Param("invoiceId") invoiceId: string, @Body() body: unknown) {
    const input = (() => {
      try {
        return parseUpdateInvoice(body);
      } catch (error: unknown) {
        throw invalid(error instanceof Error ? error.message : "The invoice update is invalid.");
      }
    })();
    let invoice: Invoice | null;
    try {
      invoice = await this.invoices.update(invoiceId, input);
    } catch (error: unknown) {
      if (isInvalidInvoiceError(error)) throw invalid(error.message);
      throw operationFailed();
    }
    if (!invoice) throw notFound();
    return invoiceResponse(invoice);
  }

  @Post(":invoiceId/issue")
  async issue(@Param("invoiceId") invoiceId: string) {
    let invoice: Invoice | null;
    try {
      invoice = await this.invoices.issue(invoiceId);
    } catch (error: unknown) {
      if (isInvalidInvoiceError(error)) throw invalid(error.message);
      throw operationFailed();
    }
    if (!invoice) throw notFound();
    return invoiceResponse(invoice);
  }

  @Post(":invoiceId/void")
  async void(@Param("invoiceId") invoiceId: string, @Body() body: unknown) {
    const reason = (() => {
      try {
        return parseVoidInvoice(body);
      } catch (error: unknown) {
        throw invalid(error instanceof Error ? error.message : "The void request is invalid.");
      }
    })();
    let invoice: Invoice | null;
    try {
      invoice = await this.invoices.void(invoiceId, reason);
    } catch (error: unknown) {
      if (isInvalidInvoiceError(error)) throw invalid(error.message);
      throw operationFailed();
    }
    if (!invoice) throw notFound();
    return invoiceResponse(invoice);
  }

  @Post(":invoiceId/payments")
  async recordPayment(
    @Param("invoiceId") invoiceId: string,
    @Body() body: unknown,
    @Req() request: FastifyRequest,
  ) {
    const input = (() => {
      try {
        return parseInvoicePayment(body);
      } catch (error: unknown) {
        throw invalid(error instanceof Error ? error.message : "The payment request is invalid.");
      }
    })();
    let key: string;
    try {
      key = parseIdempotencyKey(request.headers["idempotency-key"]);
    } catch (error: unknown) {
      throw invalid(error instanceof Error ? error.message : "Idempotency-Key is invalid.");
    }
    // A real-world payment must never be recorded twice because an HTTP
    // response was lost -- this mirrors TaskController/ReminderController's
    // idempotency-key cache exactly. Only a genuine successful record is
    // cached; a not-found or invalid-state result carries no durable effect
    // to protect, so it is never cached and a retry just repeats it.
    const fingerprint = requestFingerprint({ invoiceId, ...input });
    const cached = this.cachedPayments.get(key);
    if (cached) {
      if (cached.fingerprint !== fingerprint) {
        throw new JarvisProblem(
          HttpStatus.CONFLICT,
          "invoice-payment-idempotency-conflict",
          "Idempotency Key Conflict",
          "Idempotency-Key was already used for a different payment request.",
        );
      }
      return invoiceResponse(cached.invoice);
    }
    const pending = this.pendingPayments.get(key);
    if (pending) {
      if (pending.fingerprint !== fingerprint) {
        throw new JarvisProblem(
          HttpStatus.CONFLICT,
          "invoice-payment-idempotency-conflict",
          "Idempotency Key Conflict",
          "Idempotency-Key was already used for a different payment request.",
        );
      }
      const invoice = await pending.invoice;
      if (!invoice) throw notFound();
      return invoiceResponse(invoice);
    }
    const record = this.invoices.recordPayment(invoiceId, input);
    this.pendingPayments.set(key, { fingerprint, invoice: record });
    let invoice: Invoice | null;
    try {
      invoice = await record;
    } catch (error: unknown) {
      if (isInvalidInvoiceError(error)) throw invalid(error.message);
      throw operationFailed();
    } finally {
      this.pendingPayments.delete(key);
    }
    if (!invoice) throw notFound();
    this.cachedPayments.set(key, { fingerprint, invoice });
    while (this.cachedPayments.size > IDEMPOTENCY_CACHE_LIMIT) {
      const oldestKey = this.cachedPayments.keys().next().value;
      if (oldestKey === undefined) break;
      this.cachedPayments.delete(oldestKey);
    }
    return invoiceResponse(invoice);
  }
}
