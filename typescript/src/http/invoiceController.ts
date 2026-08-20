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
} from "@nestjs/common";

import type { Invoice, InvoiceStore } from "../invoices/invoice.js";
import {
  parseCreateInvoice,
  parseInvoicePayment,
  parseInvoiceStatus,
  parseUpdateInvoice,
  parseVoidInvoice,
} from "./invoiceRequest.js";
import { JarvisProblem } from "./problemDetails.js";
import { HTTP_INVOICE_STORE } from "./tokens.js";

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

@Controller("api/v1/invoices")
export class InvoiceController {
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
  async recordPayment(@Param("invoiceId") invoiceId: string, @Body() body: unknown) {
    const input = (() => {
      try {
        return parseInvoicePayment(body);
      } catch (error: unknown) {
        throw invalid(error instanceof Error ? error.message : "The payment request is invalid.");
      }
    })();
    let invoice: Invoice | null;
    try {
      invoice = await this.invoices.recordPayment(invoiceId, input);
    } catch (error: unknown) {
      if (isInvalidInvoiceError(error)) throw invalid(error.message);
      throw operationFailed();
    }
    if (!invoice) throw notFound();
    return invoiceResponse(invoice);
  }
}
