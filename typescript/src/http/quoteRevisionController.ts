import { Body, Controller, Get, HttpCode, Inject, Param, Post, Query } from "@nestjs/common";

import {
  QuoteFingerprintMismatchError,
  QuoteFinalizedImmutableError,
  QuoteInvalidTransitionError,
  QuoteVersionConflictError,
  type QuoteSnapshot,
} from "../quotes/quoteLifecycle.js";
import type { QuoteRepository } from "../quotes/quoteRepository.js";
import { JarvisProblem } from "./problemDetails.js";
import {
  parseCreateQuoteRevision,
  parseForkQuoteRevision,
  parseListQuoteRevisions,
  parseQuoteRevisionCommand,
  parseRecordCommercialOutcome,
  parseUpdateQuoteDraft,
} from "./quoteRevisionRequest.js";
import { HTTP_QUOTE_REPOSITORY } from "./tokens.js";

function unavailable(): JarvisProblem {
  return new JarvisProblem(
    503,
    "quote-revision-lifecycle-unavailable",
    "Quote Revision Lifecycle Unavailable",
    "The quote revision lifecycle requires the configured Convex persistence provider.",
  );
}

function invalid(detail: string): JarvisProblem {
  return new JarvisProblem(422, "invalid-quote-revision", "Invalid Quote Revision", detail);
}

function notFound(): JarvisProblem {
  return new JarvisProblem(
    404,
    "quote-revision-not-found",
    "Quote Not Found",
    "The requested quote does not exist.",
  );
}

function conflict(detail: string): JarvisProblem {
  return new JarvisProblem(409, "quote-revision-conflict", "Quote Revision Conflict", detail);
}

function operationProblem(error: unknown): JarvisProblem {
  if (error instanceof QuoteVersionConflictError) return conflict(error.message);
  if (error instanceof QuoteInvalidTransitionError) return conflict(error.message);
  if (error instanceof QuoteFinalizedImmutableError) return conflict(error.message);
  if (error instanceof QuoteFingerprintMismatchError) return conflict(error.message);
  const message = error instanceof Error ? error.message : String(error);
  if (/does not exist|no matching document/i.test(message)) return notFound();
  if (/already exists/i.test(message)) return invalid(message);
  return new JarvisProblem(
    503,
    "quote-revision-operation-failed",
    "Quote Revision Operation Failed",
    "The quote revision lifecycle could not safely complete the operation.",
  );
}

function snapshotResponse(snapshot: QuoteSnapshot): { data: QuoteSnapshot } {
  return { data: snapshot };
}

@Controller("api/v1/quote-revisions")
export class QuoteRevisionController {
  constructor(@Inject(HTTP_QUOTE_REPOSITORY) private readonly quotes: QuoteRepository | null) {}

  private requireRepository(): QuoteRepository {
    if (!this.quotes) throw unavailable();
    return this.quotes;
  }

  @Post()
  @HttpCode(201)
  async create(@Body() body: unknown) {
    let input;
    try {
      input = parseCreateQuoteRevision(body);
    } catch (error: unknown) {
      throw invalid(error instanceof Error ? error.message : "The quote request is invalid.");
    }
    try {
      return snapshotResponse(await this.requireRepository().createQuote(input));
    } catch (error: unknown) {
      if (error instanceof JarvisProblem) throw error;
      throw operationProblem(error);
    }
  }

  @Get()
  async list(
    @Query("clientId") clientId: unknown,
    @Query("projectId") projectId: unknown,
    @Query("commercialStatus") commercialStatus: unknown,
    @Query("limit") limit: unknown,
  ) {
    let input;
    try {
      input = parseListQuoteRevisions({ clientId, projectId, commercialStatus, limit });
    } catch (error: unknown) {
      throw invalid(error instanceof Error ? error.message : "The quote list query is invalid.");
    }
    try {
      const data = await this.requireRepository().listQuotes(input);
      return { data, count: data.length };
    } catch (error: unknown) {
      if (error instanceof JarvisProblem) throw error;
      throw operationProblem(error);
    }
  }

  @Get(":quoteId")
  async get(@Param("quoteId") quoteId: string) {
    let snapshot: QuoteSnapshot | null;
    try {
      snapshot = await this.requireRepository().getQuote(quoteId);
    } catch (error: unknown) {
      if (error instanceof JarvisProblem) throw error;
      throw operationProblem(error);
    }
    if (!snapshot) throw notFound();
    return snapshotResponse(snapshot);
  }

  @Post(":quoteId/revisions/:revision/draft")
  @HttpCode(200)
  async updateDraft(
    @Param("quoteId") quoteId: string,
    @Param("revision") revision: string,
    @Body() body: unknown,
  ) {
    let input;
    try {
      input = parseUpdateQuoteDraft(quoteId, revision, body);
    } catch (error: unknown) {
      throw invalid(error instanceof Error ? error.message : "The draft update is invalid.");
    }
    try {
      return snapshotResponse(await this.requireRepository().updateDraft(input));
    } catch (error: unknown) {
      if (error instanceof JarvisProblem) throw error;
      throw operationProblem(error);
    }
  }

  @Post(":quoteId/revisions/:revision/submit")
  @HttpCode(200)
  async submitForReview(
    @Param("quoteId") quoteId: string,
    @Param("revision") revision: string,
    @Body() body: unknown,
  ) {
    let input;
    try {
      input = parseQuoteRevisionCommand(quoteId, revision, body);
    } catch (error: unknown) {
      throw invalid(error instanceof Error ? error.message : "The revision command is invalid.");
    }
    try {
      return snapshotResponse(await this.requireRepository().submitForReview(input));
    } catch (error: unknown) {
      if (error instanceof JarvisProblem) throw error;
      throw operationProblem(error);
    }
  }

  @Post(":quoteId/revisions/:revision/reopen")
  @HttpCode(200)
  async reopenForEditing(
    @Param("quoteId") quoteId: string,
    @Param("revision") revision: string,
    @Body() body: unknown,
  ) {
    let input;
    try {
      input = parseQuoteRevisionCommand(quoteId, revision, body);
    } catch (error: unknown) {
      throw invalid(error instanceof Error ? error.message : "The revision command is invalid.");
    }
    try {
      return snapshotResponse(await this.requireRepository().reopenForEditing(input));
    } catch (error: unknown) {
      if (error instanceof JarvisProblem) throw error;
      throw operationProblem(error);
    }
  }

  @Post(":quoteId/revisions/:revision/finalize")
  @HttpCode(200)
  async finalizeRevision(
    @Param("quoteId") quoteId: string,
    @Param("revision") revision: string,
    @Body() body: unknown,
  ) {
    let input;
    try {
      input = parseQuoteRevisionCommand(quoteId, revision, body);
    } catch (error: unknown) {
      throw invalid(error instanceof Error ? error.message : "The revision command is invalid.");
    }
    try {
      return snapshotResponse(await this.requireRepository().finalizeRevision(input));
    } catch (error: unknown) {
      if (error instanceof JarvisProblem) throw error;
      throw operationProblem(error);
    }
  }

  @Post(":quoteId/revisions/:revision/fork")
  @HttpCode(201)
  async createRevisionFromFinalized(
    @Param("quoteId") quoteId: string,
    @Param("revision") revision: string,
    @Body() body: unknown,
  ) {
    let input;
    try {
      input = parseForkQuoteRevision(quoteId, revision, body);
    } catch (error: unknown) {
      throw invalid(error instanceof Error ? error.message : "The fork request is invalid.");
    }
    try {
      return snapshotResponse(await this.requireRepository().createRevisionFromFinalized(input));
    } catch (error: unknown) {
      if (error instanceof JarvisProblem) throw error;
      throw operationProblem(error);
    }
  }

  @Post(":quoteId/commercial-outcome")
  @HttpCode(200)
  async recordCommercialOutcome(@Param("quoteId") quoteId: string, @Body() body: unknown) {
    let input;
    try {
      input = parseRecordCommercialOutcome(quoteId, body);
    } catch (error: unknown) {
      throw invalid(
        error instanceof Error ? error.message : "The commercial outcome request is invalid.",
      );
    }
    try {
      return snapshotResponse(await this.requireRepository().recordCommercialOutcome(input));
    } catch (error: unknown) {
      if (error instanceof JarvisProblem) throw error;
      throw operationProblem(error);
    }
  }
}
