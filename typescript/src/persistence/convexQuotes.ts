import { api } from "../../convex/_generated/api.js";
import {
  QuoteFinalizedImmutableError,
  QuoteFingerprintMismatchError,
  QuoteInvalidTransitionError,
  type QuoteAggregate,
  type QuoteRevision,
  type QuoteSnapshot,
  QuoteVersionConflictError,
} from "../quotes/quoteLifecycle.js";
import type {
  CreateQuoteInput,
  CreateQuoteRevisionInput,
  FinalizeQuoteRevisionInput,
  ListQuotesInput,
  QuoteRepository,
  QuoteRevisionCommand,
  QuoteSummary,
  RecordQuoteCommercialOutcomeInput,
  UpdateQuoteDraftInput,
} from "../quotes/quoteRepository.js";
import type { ConvexClientLike } from "./convexPersistence.js";

export const quoteFunctions = api.quotes;

type ConvexQuoteAggregateRow = QuoteAggregate & {
  _id: string;
  _creationTime: number;
};

type ConvexQuoteRevisionRow = QuoteRevision & {
  _id: string;
  _creationTime: number;
};

type ConvexQuoteSnapshotRow = {
  aggregate: ConvexQuoteAggregateRow;
  revision: ConvexQuoteRevisionRow;
};

export type ConvexQuoteRepositoryOptions = {
  client: ConvexClientLike;
  serviceToken: string;
};

function aggregateFromConvex(row: ConvexQuoteAggregateRow): QuoteAggregate {
  return {
    quoteId: row.quoteId,
    ownerId: row.ownerId,
    clientId: row.clientId,
    ...(row.projectId === undefined ? {} : { projectId: row.projectId }),
    number: row.number,
    currentRevision: row.currentRevision,
    currentRevisionId: row.currentRevisionId,
    aggregateVersion: row.aggregateVersion,
    commercialStatus: row.commercialStatus,
    ...(row.commercialRevision === undefined ? {} : { commercialRevision: row.commercialRevision }),
    ...(row.commercialRecordedAt === undefined
      ? {}
      : { commercialRecordedAt: row.commercialRecordedAt }),
    createdAt: row.createdAt,
    updatedAt: row.updatedAt,
  };
}

function revisionFromConvex(row: ConvexQuoteRevisionRow): QuoteRevision {
  return {
    revisionId: row.revisionId,
    ownerId: row.ownerId,
    quoteId: row.quoteId,
    revision: row.revision,
    revisionVersion: row.revisionVersion,
    status: row.status,
    lineItems: row.lineItems.map((item) => ({ ...item })),
    subtotal: row.subtotal,
    ...(row.taxRate === undefined ? {} : { taxRate: row.taxRate }),
    tax: row.tax,
    total: row.total,
    currency: row.currency,
    ...(row.validUntil === undefined ? {} : { validUntil: row.validUntil }),
    ...(row.notes === undefined ? {} : { notes: row.notes }),
    termsIncluded: row.termsIncluded,
    ...(row.fingerprint === undefined ? {} : { fingerprint: row.fingerprint }),
    ...(row.predecessorRevisionId === undefined
      ? {}
      : { predecessorRevisionId: row.predecessorRevisionId }),
    ...(row.historicalOutcome === undefined ? {} : { historicalOutcome: row.historicalOutcome }),
    ...(row.historicalOutcomeRecordedAt === undefined
      ? {}
      : { historicalOutcomeRecordedAt: row.historicalOutcomeRecordedAt }),
    ...(row.reviewedAt === undefined ? {} : { reviewedAt: row.reviewedAt }),
    ...(row.finalizedAt === undefined ? {} : { finalizedAt: row.finalizedAt }),
    createdAt: row.createdAt,
    updatedAt: row.updatedAt,
  };
}

function snapshotFromConvex(row: ConvexQuoteSnapshotRow): QuoteSnapshot {
  return {
    aggregate: aggregateFromConvex(row.aggregate),
    revision: revisionFromConvex(row.revision),
  };
}

function summaryFromConvex(row: ConvexQuoteSnapshotRow): QuoteSummary {
  return {
    quoteId: row.aggregate.quoteId,
    clientId: row.aggregate.clientId,
    ...(row.aggregate.projectId === undefined ? {} : { projectId: row.aggregate.projectId }),
    number: row.aggregate.number,
    currentRevision: row.aggregate.currentRevision,
    aggregateVersion: row.aggregate.aggregateVersion,
    revisionStatus: row.revision.status,
    commercialStatus: row.aggregate.commercialStatus,
    total: row.revision.total,
    currency: row.revision.currency,
    updatedAt: row.aggregate.updatedAt,
  };
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function restoreQuoteDomainError(error: unknown): never {
  if (
    error instanceof QuoteVersionConflictError ||
    error instanceof QuoteInvalidTransitionError ||
    error instanceof QuoteFinalizedImmutableError ||
    error instanceof QuoteFingerprintMismatchError
  ) {
    throw error;
  }

  const message = errorMessage(error);
  if (message.includes("QuoteVersionConflictError")) {
    throw new QuoteVersionConflictError(message);
  }
  if (message.includes("QuoteInvalidTransitionError")) {
    throw new QuoteInvalidTransitionError(message);
  }
  if (message.includes("QuoteFinalizedImmutableError")) {
    throw new QuoteFinalizedImmutableError(message);
  }
  if (message.includes("QuoteFingerprintMismatchError")) {
    throw new QuoteFingerprintMismatchError(message);
  }
  throw error;
}

export class ConvexQuoteRepository implements QuoteRepository {
  private readonly client: ConvexClientLike;
  private readonly serviceToken: string;

  constructor({ client, serviceToken }: ConvexQuoteRepositoryOptions) {
    if (!serviceToken) throw new Error("Convex quotes require JARVIS_SERVICE_TOKEN.");
    this.client = client;
    this.serviceToken = serviceToken;
  }

  async createQuote(input: CreateQuoteInput): Promise<QuoteSnapshot> {
    try {
      const row = await this.client.mutation(quoteFunctions.create, {
        serviceToken: this.serviceToken,
        clientId: input.clientId,
        ...(input.projectId === undefined ? {} : { projectId: input.projectId }),
        number: input.number,
        lineItems: input.lineItems,
        ...(input.taxRate === undefined ? {} : { taxRate: input.taxRate }),
        ...(input.validUntil === undefined ? {} : { validUntil: input.validUntil }),
        ...(input.notes === undefined ? {} : { notes: input.notes }),
        termsIncluded: input.termsIncluded,
      });
      return snapshotFromConvex(row as ConvexQuoteSnapshotRow);
    } catch (error: unknown) {
      restoreQuoteDomainError(error);
    }
  }

  async getQuote(quoteId: string): Promise<QuoteSnapshot | null> {
    try {
      const row = await this.client.query(quoteFunctions.get, {
        serviceToken: this.serviceToken,
        quoteId,
      });
      return row === null ? null : snapshotFromConvex(row as ConvexQuoteSnapshotRow);
    } catch (error: unknown) {
      restoreQuoteDomainError(error);
    }
  }

  async listQuotes(input: ListQuotesInput): Promise<QuoteSummary[]> {
    try {
      const rows = await this.client.query(quoteFunctions.list, {
        serviceToken: this.serviceToken,
        ...(input.clientId === undefined ? {} : { clientId: input.clientId }),
        ...(input.projectId === undefined ? {} : { projectId: input.projectId }),
        ...(input.commercialStatus === undefined
          ? {}
          : { commercialStatus: input.commercialStatus }),
        ...(input.limit === undefined ? {} : { limit: input.limit }),
      });
      return (rows as ConvexQuoteSnapshotRow[]).map(summaryFromConvex);
    } catch (error: unknown) {
      restoreQuoteDomainError(error);
    }
  }

  async updateDraft(input: UpdateQuoteDraftInput): Promise<QuoteSnapshot> {
    return this.runRevisionMutation(quoteFunctions.updateDraft, {
      quoteId: input.quoteId,
      revision: input.revision,
      expectedAggregateVersion: input.expectedAggregateVersion,
      expectedRevisionVersion: input.expectedRevisionVersion,
      patch: {
        ...(input.patch.lineItems === undefined ? {} : { lineItems: input.patch.lineItems }),
        ...(input.patch.taxRate === undefined ? {} : { taxRate: input.patch.taxRate }),
        ...(input.patch.validUntil === undefined ? {} : { validUntil: input.patch.validUntil }),
        ...(input.patch.notes === undefined ? {} : { notes: input.patch.notes }),
        ...(input.patch.termsIncluded === undefined
          ? {}
          : { termsIncluded: input.patch.termsIncluded }),
      },
    });
  }

  async submitForReview(input: QuoteRevisionCommand): Promise<QuoteSnapshot> {
    return this.runRevisionMutation(quoteFunctions.submitForReview, input);
  }

  async reopenForEditing(input: QuoteRevisionCommand): Promise<QuoteSnapshot> {
    return this.runRevisionMutation(quoteFunctions.reopenForEditing, input);
  }

  async finalizeRevision(input: FinalizeQuoteRevisionInput): Promise<QuoteSnapshot> {
    return this.runRevisionMutation(quoteFunctions.finalizeRevision, input);
  }

  async createRevisionFromFinalized(input: CreateQuoteRevisionInput): Promise<QuoteSnapshot> {
    return this.runRevisionMutation(quoteFunctions.forkRevision, input);
  }

  async recordCommercialOutcome(input: RecordQuoteCommercialOutcomeInput): Promise<QuoteSnapshot> {
    try {
      const row = await this.client.mutation(quoteFunctions.recordCommercialOutcome, {
        serviceToken: this.serviceToken,
        quoteId: input.quoteId,
        revision: input.revision,
        expectedAggregateVersion: input.expectedAggregateVersion,
        outcome: input.outcome,
      });
      return snapshotFromConvex(row as ConvexQuoteSnapshotRow);
    } catch (error: unknown) {
      restoreQuoteDomainError(error);
    }
  }

  private async runRevisionMutation(
    functionReference: Parameters<ConvexClientLike["mutation"]>[0],
    input:
      QuoteRevisionCommand | CreateQuoteRevisionInput | (QuoteRevisionCommand & { patch: unknown }),
  ): Promise<QuoteSnapshot> {
    try {
      const row = await this.client.mutation(functionReference, {
        serviceToken: this.serviceToken,
        ...input,
      });
      return snapshotFromConvex(row as ConvexQuoteSnapshotRow);
    } catch (error: unknown) {
      restoreQuoteDomainError(error);
    }
  }
}
