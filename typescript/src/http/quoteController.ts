import {
  Body,
  Controller,
  Get,
  HttpCode,
  Inject,
  Param,
  Patch,
  Post,
  Query,
  Req,
  Res,
  StreamableFile,
} from "@nestjs/common";
import type { FastifyReply, FastifyRequest } from "fastify";

import { withClientReferenceLock } from "../clients/clientReferenceLock.js";
import {
  QuoteFingerprintMismatchError,
  QuoteFinalizedImmutableError,
  QuoteInvalidTransitionError,
  QuoteVersionConflictError,
  type QuoteSnapshot,
} from "../quotes/quoteLifecycle.js";
import type {
  QuoteDeliveryAttempt,
  QuoteDeliveryRepository,
} from "../quotes/quoteDeliveryRepository.js";
import {
  QuotePdfArtifactReadError,
  type QuotePdfArtifactRepository,
} from "../quotes/quotePdfArtifactRepository.js";
import type { QuoteRepository } from "../quotes/quoteRepository.js";
import { JarvisProblem } from "./problemDetails.js";
import {
  parseCreateQuoteRevision,
  parseForkQuoteRevision,
  parseListQuoteRevisions,
  parseQuoteFinalization,
  parseQuoteRevisionCommand,
  parseQuoteRevisionParam,
  parseRecordCommercialOutcome,
  parseUpdateQuoteDraft,
} from "./quoteRequest.js";
import {
  HTTP_QUOTE_DELIVERY_REPOSITORY,
  HTTP_QUOTE_PDF_ARTIFACT_REPOSITORY,
  HTTP_QUOTE_REPOSITORY,
} from "./tokens.js";

function unavailable(): JarvisProblem {
  return new JarvisProblem(
    503,
    "quote-lifecycle-unavailable",
    "Quote Lifecycle Unavailable",
    "The quote lifecycle requires the configured Convex persistence provider.",
  );
}

function deliveriesUnavailable(): JarvisProblem {
  return new JarvisProblem(
    503,
    "quote-delivery-lifecycle-unavailable",
    "Quote Delivery Lifecycle Unavailable",
    "The quote delivery ledger is not yet commissioned.",
  );
}

function pdfUnavailable(): JarvisProblem {
  return new JarvisProblem(
    503,
    "quote-pdf-unavailable",
    "Quote PDF Unavailable",
    "The stored quote PDF reader is not configured.",
  );
}

function pdfReadProblem(error: QuotePdfArtifactReadError): JarvisProblem {
  if (
    error.code === "quote-pdf-artifact-digest-mismatch" ||
    error.code === "quote-pdf-artifact-fingerprint-mismatch"
  ) {
    return new JarvisProblem(
      409,
      error.code,
      "Quote PDF Verification Failed",
      "The stored quote PDF did not match its recorded digest or revision fingerprint.",
    );
  }
  return new JarvisProblem(
    503,
    error.code,
    "Quote PDF Unavailable",
    "The stored quote PDF could not be read.",
  );
}

function contentDisposition(filename: string): string {
  const ascii = filename.replace(/["\\]/g, "_").replace(/[^\x20-\x7E]/g, "_");
  return `attachment; filename="${ascii}"`;
}

function clientAbortSignal(request: FastifyRequest): AbortSignal {
  const controller = new AbortController();
  const abort = (): void => controller.abort();
  request.raw.once("aborted", abort);
  request.raw.socket.once("close", abort);
  return controller.signal;
}

function invalid(detail: string): JarvisProblem {
  return new JarvisProblem(422, "invalid-quote", "Invalid Quote", detail);
}

function notFound(): JarvisProblem {
  return new JarvisProblem(
    404,
    "quote-not-found",
    "Quote Not Found",
    "The requested quote does not exist.",
  );
}

function conflict(detail: string): JarvisProblem {
  return new JarvisProblem(409, "quote-conflict", "Quote Conflict", detail);
}

function operationProblem(error: unknown): JarvisProblem {
  if (error instanceof QuoteVersionConflictError) return conflict(error.message);
  if (error instanceof QuoteInvalidTransitionError) return conflict(error.message);
  if (error instanceof QuoteFinalizedImmutableError) return conflict(error.message);
  if (error instanceof QuoteFingerprintMismatchError) return conflict(error.message);
  const message = error instanceof Error ? error.message : String(error);
  if (/does not exist|no matching document|not found/i.test(message)) return notFound();
  if (/already exists/i.test(message)) return invalid(message);
  return new JarvisProblem(
    503,
    "quote-operation-failed",
    "Quote Operation Failed",
    "The quote lifecycle could not safely complete the operation.",
  );
}

function snapshotResponse(snapshot: QuoteSnapshot): { data: QuoteSnapshot } {
  return { data: snapshot };
}

type QuoteDeliveryAttemptResponse = {
  deliveryAttemptId: string;
  quoteId: string;
  revision: number;
  revisionId: string;
  revisionFingerprint: string;
  recipient: string;
  channel: "email";
  status: QuoteDeliveryAttempt["status"];
  reconciledOutcome?: "succeeded" | "failed";
  provider: string;
  providerRequestId?: string;
  providerCorrelationId?: string;
  reconciliationId?: string;
  providerErrorCode?: string;
  createdAt: number;
  executionStartedAt?: number;
  completedAt?: number;
  reconciledAt?: number;
  updatedAt: number;
};

/**
 * Strips internal correlation fields (ownerId, sendFingerprint, idempotencyKey,
 * approvalId, actionFingerprint) that exist for exactly-once enforcement but
 * have no reason to leave the server — matches the OpenAPI QuoteDeliveryAttempt
 * schema, which does not list them.
 */
function deliveryResponse(attempt: QuoteDeliveryAttempt): QuoteDeliveryAttemptResponse {
  return {
    deliveryAttemptId: attempt.deliveryAttemptId,
    quoteId: attempt.quoteId,
    revision: attempt.revision,
    revisionId: attempt.revisionId,
    revisionFingerprint: attempt.revisionFingerprint,
    recipient: attempt.recipient,
    channel: attempt.channel,
    status: attempt.status,
    ...(attempt.reconciledOutcome === undefined
      ? {}
      : { reconciledOutcome: attempt.reconciledOutcome }),
    provider: attempt.provider,
    ...(attempt.providerRequestId === undefined
      ? {}
      : { providerRequestId: attempt.providerRequestId }),
    ...(attempt.providerCorrelationId === undefined
      ? {}
      : { providerCorrelationId: attempt.providerCorrelationId }),
    ...(attempt.reconciliationId === undefined
      ? {}
      : { reconciliationId: attempt.reconciliationId }),
    ...(attempt.providerErrorCode === undefined
      ? {}
      : { providerErrorCode: attempt.providerErrorCode }),
    createdAt: attempt.createdAt,
    ...(attempt.executionStartedAt === undefined
      ? {}
      : { executionStartedAt: attempt.executionStartedAt }),
    ...(attempt.completedAt === undefined ? {} : { completedAt: attempt.completedAt }),
    ...(attempt.reconciledAt === undefined ? {} : { reconciledAt: attempt.reconciledAt }),
    updatedAt: attempt.updatedAt,
  };
}

@Controller("api/v1/quotes")
export class QuoteController {
  constructor(
    @Inject(HTTP_QUOTE_REPOSITORY) private readonly quotes: QuoteRepository | null,
    @Inject(HTTP_QUOTE_DELIVERY_REPOSITORY)
    private readonly deliveries: QuoteDeliveryRepository | null,
    @Inject(HTTP_QUOTE_PDF_ARTIFACT_REPOSITORY)
    private readonly pdfArtifacts: QuotePdfArtifactRepository | null,
  ) {}

  private requireRepository(): QuoteRepository {
    if (!this.quotes) throw unavailable();
    return this.quotes;
  }

  private requirePdfArtifacts(): QuotePdfArtifactRepository {
    if (!this.pdfArtifacts) throw pdfUnavailable();
    return this.pdfArtifacts;
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
      return await withClientReferenceLock(async () =>
        snapshotResponse(await this.requireRepository().createQuote(input)),
      );
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

  @Patch(":quoteId/revisions/:revision")
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

  @Post(":quoteId/revisions/:revision/review")
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
      input = parseQuoteFinalization(quoteId, revision, body);
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

  @Get(":quoteId/revisions/:revision/pdf")
  async readPdf(
    @Param("quoteId") quoteId: string,
    @Param("revision") revisionParam: string,
    @Req() request: FastifyRequest,
    @Res({ passthrough: true }) reply: FastifyReply,
  ): Promise<StreamableFile> {
    const repository = this.requireRepository();
    const artifacts = this.requirePdfArtifacts();
    let revision: number;
    try {
      revision = parseQuoteRevisionParam(revisionParam);
    } catch (error: unknown) {
      throw invalid(
        error instanceof Error ? error.message : "Revision must be a positive integer.",
      );
    }
    let snapshot: QuoteSnapshot | null;
    try {
      snapshot = await repository.getQuote(quoteId);
    } catch (error: unknown) {
      if (error instanceof JarvisProblem) throw error;
      throw operationProblem(error);
    }
    const fingerprint = snapshot?.revision.fingerprint;
    if (
      !snapshot ||
      snapshot.aggregate.currentRevision !== revision ||
      snapshot.revision.revision !== revision ||
      snapshot.revision.status !== "finalized" ||
      fingerprint === undefined
    ) {
      throw notFound();
    }
    let stored;
    try {
      stored = await artifacts.getForRevision(
        {
          quoteId,
          revision,
          expectedRevisionFingerprint: fingerprint,
        },
        clientAbortSignal(request),
      );
    } catch (error: unknown) {
      if (error instanceof JarvisProblem) throw error;
      if (error instanceof QuotePdfArtifactReadError) throw pdfReadProblem(error);
      throw pdfUnavailable();
    }
    if (
      !stored ||
      stored.quoteId !== quoteId ||
      stored.revision !== revision ||
      stored.revisionId !== snapshot.revision.revisionId ||
      stored.revisionFingerprint !== fingerprint ||
      stored.mediaType !== "application/pdf" ||
      stored.bytes.byteLength !== stored.byteLength
    ) {
      throw notFound();
    }
    reply.header("X-Quote-Pdf-Digest", stored.digest);
    return new StreamableFile(Buffer.from(stored.bytes), {
      type: stored.mediaType,
      disposition: contentDisposition(stored.filename),
      length: stored.byteLength,
    });
  }

  @Get(":quoteId/deliveries")
  async listDeliveries(
    @Param("quoteId") quoteId: string,
  ): Promise<{ data: QuoteDeliveryAttemptResponse[]; count: number }> {
    if (!this.deliveries) throw deliveriesUnavailable();
    const attempts = await this.deliveries.listForQuote({ quoteId });
    const data = attempts.map(deliveryResponse);
    return { data, count: data.length };
  }
}
