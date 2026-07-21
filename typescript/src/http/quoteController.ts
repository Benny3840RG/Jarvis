import {
  Body,
  Controller,
  Delete,
  Get,
  HttpCode,
  HttpStatus,
  Inject,
  Param,
  Patch,
  Post,
} from "@nestjs/common";

import type { Quote, QuoteStore } from "../quotes/quote.js";
import { JarvisProblem } from "./problemDetails.js";
import { parseCreateQuote, parseUpdateQuote } from "./quoteRequest.js";
import { HTTP_QUOTE_STORE } from "./tokens.js";

function invalid(detail: string): JarvisProblem {
  return new JarvisProblem(
    HttpStatus.UNPROCESSABLE_ENTITY,
    "invalid-quote",
    "Invalid Quote",
    detail,
  );
}

function notFound(): JarvisProblem {
  return new JarvisProblem(
    HttpStatus.NOT_FOUND,
    "quote-not-found",
    "Quote Not Found",
    "The requested quote does not exist.",
  );
}

function operationFailed(): JarvisProblem {
  return new JarvisProblem(
    HttpStatus.SERVICE_UNAVAILABLE,
    "quote-persistence-failed",
    "Quote Operation Failed",
    "The configured quote store could not complete the operation.",
  );
}

function quoteResponse(quote: Quote): { data: Quote } {
  return { data: quote };
}

@Controller("api/v1/quotes")
export class QuoteController {
  constructor(@Inject(HTTP_QUOTE_STORE) private readonly quotes: QuoteStore) {}

  @Get()
  async list() {
    try {
      const data = await this.quotes.list();
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
        return parseCreateQuote(body);
      } catch (error: unknown) {
        throw invalid(error instanceof Error ? error.message : "The quote request is invalid.");
      }
    })();
    try {
      return quoteResponse(await this.quotes.add(input));
    } catch (error: unknown) {
      if (error instanceof Error && /empty|must be|status must/.test(error.message))
        throw invalid(error.message);
      throw operationFailed();
    }
  }

  @Get(":quoteId")
  async get(@Param("quoteId") quoteId: string) {
    let quote: Quote | null;
    try {
      quote = await this.quotes.get(quoteId);
    } catch {
      throw operationFailed();
    }
    if (!quote) throw notFound();
    return quoteResponse(quote);
  }

  @Patch(":quoteId")
  async update(@Param("quoteId") quoteId: string, @Body() body: unknown) {
    const input = (() => {
      try {
        return parseUpdateQuote(body);
      } catch (error: unknown) {
        throw invalid(error instanceof Error ? error.message : "The quote update is invalid.");
      }
    })();
    let quote: Quote | null;
    try {
      quote = await this.quotes.update(quoteId, input);
    } catch (error: unknown) {
      if (error instanceof Error && /empty|must be|requires|status must/.test(error.message))
        throw invalid(error.message);
      throw operationFailed();
    }
    if (!quote) throw notFound();
    return quoteResponse(quote);
  }

  @Delete(":quoteId")
  async remove(@Param("quoteId") quoteId: string) {
    let quote: Quote | null;
    try {
      quote = await this.quotes.remove(quoteId);
    } catch {
      throw operationFailed();
    }
    if (!quote) throw notFound();
    return quoteResponse(quote);
  }
}
