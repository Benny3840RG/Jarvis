import { ConvexHttpClient } from "convex/browser";

import { api } from "../../convex/_generated/api.js";
import type { ConvexClientLike } from "../persistence/convexPersistence.js";
import {
  QuoteFinalizedImmutableError,
  QuoteFingerprintMismatchError,
  QuoteInvalidTransitionError,
  type QuoteAggregate,
  type QuoteRevision,
  type QuoteSnapshot,
  QuoteVersionConflictError,
} from "./quoteLifecycle.js";
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
} from "./quoteRepository.js";

export const quoteFunctions = api.quotes;

type AggregateDoc = QuoteAggregate & { _id: string; _creationTime: number };
type RevisionDoc = QuoteRevision & { _id: string; _creationTime: number };
type SnapshotDoc = { aggregate: AggregateDoc; revision: RevisionDoc };

export type ConvexQuoteRepositoryOptions = {
  client: ConvexClientLike;
  serviceToken: string;
};

function aggregateFromDoc(doc: AggregateDoc): QuoteAggregate {
  return {
    quoteId: doc.quoteId,
    ownerId: doc.ownerId,
    clientId: doc.clientId,
    ...(doc.projectId === undefined ? {} : { projectId: doc.projectId }),
    number: doc.number,
    currentRevision: doc.currentRevision,
    currentRevisionId: doc.currentRevisionId,
    aggregateVersion: doc.aggregateVersion,
    commercialStatus: doc.commercialStatus,
    ...(doc.commercialRevision === undefined ? {} : { commercialRevision: doc.commercialRevision }),
    ...(doc.commercialRecordedAt === undefined
      ? {}
      : { commercialRecordedAt: doc.commercialRecordedAt }),
    createdAt: doc.createdAt,
    updatedAt: doc.updatedAt,
  };
}

function revisionFromDoc(doc: RevisionDoc): QuoteRevision {
  return {
    revisionId: doc.revisionId,
    ownerId: doc.ownerId,
    quoteId: doc.quoteId,
    revision: doc.revision,
    revisionVersion: doc.revisionVersion,
    status: doc.status,
    lineItems: doc.lineItems.map((item) => ({
      description: item.description,
      quantity: item.quantity,
      unitPrice: item.unitPrice,
    })),
    subtotal: doc.subtotal,
    ...(doc.taxRate === undefined ? {} : { taxRate: doc.taxRate }),
    tax: doc.tax,
    total: doc.total,
    currency: doc.currency,
    ...(doc.validUntil === undefined ? {} : { validUntil: doc.validUntil }),
    ...(doc.notes === undefined ? {} : { notes: doc.notes }),
    termsIncluded: doc.termsIncluded,
    ...(doc.fingerprint === undefined ? {} : { fingerprint: doc.fingerprint }),
    ...(doc.predecessorRevisionId === undefined
      ? {}
      : { predecessorRevisionId: doc.predecessorRevisionId }),
    ...(doc.historicalOutcome === undefined ? {} : { historicalOutcome: doc.historicalOutcome }),
    ...(doc.historicalOutcomeRecordedAt === undefined
      ? {}
      : { historicalOutcomeRecordedAt: doc.historicalOutcomeRecordedAt }),
    ...(doc.reviewedAt === undefined ? {} : { reviewedAt: doc.reviewedAt }),
    ...(doc.finalizedAt === undefined ? {} : { finalizedAt: doc.finalizedAt }),
    createdAt: doc.createdAt,
    updatedAt: doc.updatedAt,
  };
}

function snapshotFromDoc(doc: SnapshotDoc): QuoteSnapshot {
  return { aggregate: aggregateFromDoc(doc.aggregate), revision: revisionFromDoc(doc.revision) };
}

function summaryFromDoc(doc: SnapshotDoc): QuoteSummary {
  const { aggregate, revision } = doc;
  return {
    quoteId: aggregate.quoteId,
    clientId: aggregate.clientId,
    ...(aggregate.projectId === undefined ? {} : { projectId: aggregate.projectId }),
    number: aggregate.number,
    currentRevision: aggregate.currentRevision,
    aggregateVersion: aggregate.aggregateVersion,
    revisionStatus: revision.status,
    commercialStatus: aggregate.commercialStatus,
    total: revision.total,
    currency: revision.currency,
    updatedAt: aggregate.updatedAt,
  };
}

function isConvexClient(
  value: ConvexQuoteRepositoryOptions | ConvexClientLike | undefined,
): value is ConvexClientLike {
  return (
    value !== undefined && typeof value === "object" && "query" in value && "mutation" in value
  );
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

/**
 * Convex-backed {@link QuoteRepository}. Selected when PERSISTENCE_PROVIDER=convex
 * so the quote revision/delivery lifecycle lives in the same durable deployment
 * as the rest of Jarvis's memory. All authority and lifecycle invariants
 * (owner-scoping, optimistic concurrency, finalized-immutability, fingerprint-
 * bound forking) are enforced server-side by `convex/quotes.ts`; this adapter
 * only maps between the domain input/output types and the Convex function
 * signatures, and never re-implements a rule the server owns.
 */
export class ConvexQuoteRepository implements QuoteRepository {
  private readonly client: ConvexClientLike;
  private readonly serviceToken: string;

  constructor(options: ConvexQuoteRepositoryOptions);
  constructor(client?: ConvexClientLike, serviceToken?: string);
  constructor(
    optionsOrClient?: ConvexQuoteRepositoryOptions | ConvexClientLike,
    legacyServiceToken?: string,
  ) {
    let client: ConvexClientLike | undefined;
    let serviceToken: string | undefined;

    if (isConvexClient(optionsOrClient) || optionsOrClient === undefined) {
      client = optionsOrClient;
      serviceToken = legacyServiceToken ?? process.env.JARVIS_SERVICE_TOKEN;
    } else {
      client = optionsOrClient.client;
      serviceToken = optionsOrClient.serviceToken;
    }

    if (!serviceToken) {
      throw new Error(
        "PERSISTENCE_PROVIDER=convex requires JARVIS_SERVICE_TOKEN. The deployment URL is not authentication.",
      );
    }
    this.serviceToken = serviceToken;

    if (client) {
      this.client = client;
      return;
    }

    const convexUrl = process.env.CONVEX_URL;
    if (!convexUrl) {
      throw new Error(
        "PERSISTENCE_PROVIDER=convex requires CONVEX_URL to be set in the environment.",
      );
    }
    this.client = new ConvexHttpClient(convexUrl);
  }

  async createQuote(input: CreateQuoteInput): Promise<QuoteSnapshot> {
    const doc = await this.mutation<SnapshotDoc>(quoteFunctions.create, {
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
    return snapshotFromDoc(doc);
  }

  async getQuote(quoteId: string): Promise<QuoteSnapshot | null> {
    const doc = await this.query<SnapshotDoc | null>(quoteFunctions.get, {
      serviceToken: this.serviceToken,
      quoteId,
    });
    return doc === null ? null : snapshotFromDoc(doc);
  }

  async listQuotes(input: ListQuotesInput): Promise<QuoteSummary[]> {
    const docs = await this.query<SnapshotDoc[]>(quoteFunctions.list, {
      serviceToken: this.serviceToken,
      ...(input.clientId === undefined ? {} : { clientId: input.clientId }),
      ...(input.projectId === undefined ? {} : { projectId: input.projectId }),
      ...(input.commercialStatus === undefined ? {} : { commercialStatus: input.commercialStatus }),
      ...(input.limit === undefined ? {} : { limit: input.limit }),
    });
    return docs.map(summaryFromDoc);
  }

  async updateDraft(input: UpdateQuoteDraftInput): Promise<QuoteSnapshot> {
    const doc = await this.mutation<SnapshotDoc>(quoteFunctions.updateDraft, {
      serviceToken: this.serviceToken,
      quoteId: input.quoteId,
      revision: input.revision,
      expectedAggregateVersion: input.expectedAggregateVersion,
      expectedRevisionVersion: input.expectedRevisionVersion,
      patch: input.patch,
    });
    return snapshotFromDoc(doc);
  }

  async submitForReview(input: QuoteRevisionCommand): Promise<QuoteSnapshot> {
    return snapshotFromDoc(
      await this.mutation<SnapshotDoc>(quoteFunctions.submitForReview, this.revisionCommand(input)),
    );
  }

  async reopenForEditing(input: QuoteRevisionCommand): Promise<QuoteSnapshot> {
    return snapshotFromDoc(
      await this.mutation<SnapshotDoc>(
        quoteFunctions.reopenForEditing,
        this.revisionCommand(input),
      ),
    );
  }

  async finalizeRevision(input: FinalizeQuoteRevisionInput): Promise<QuoteSnapshot> {
    return snapshotFromDoc(
      await this.mutation<SnapshotDoc>(
        quoteFunctions.finalizeRevision,
        this.revisionCommand(input),
      ),
    );
  }

  async createRevisionFromFinalized(input: CreateQuoteRevisionInput): Promise<QuoteSnapshot> {
    const doc = await this.mutation<SnapshotDoc>(quoteFunctions.forkRevision, {
      ...this.revisionCommand(input),
      expectedFingerprint: input.expectedFingerprint,
    });
    return snapshotFromDoc(doc);
  }

  async recordCommercialOutcome(input: RecordQuoteCommercialOutcomeInput): Promise<QuoteSnapshot> {
    const doc = await this.mutation<SnapshotDoc>(quoteFunctions.recordCommercialOutcome, {
      serviceToken: this.serviceToken,
      quoteId: input.quoteId,
      revision: input.revision,
      expectedAggregateVersion: input.expectedAggregateVersion,
      outcome: input.outcome,
    });
    return snapshotFromDoc(doc);
  }

  async cleanup(quoteId: string): Promise<void> {
    await this.mutation<null>(api.quoteMigration.cleanupImportedQuote, {
      serviceToken: this.serviceToken,
      quoteId,
    });
  }

  private async query<T>(
    functionReference: Parameters<ConvexClientLike["query"]>[0],
    args: Record<string, unknown>,
  ): Promise<T> {
    try {
      return (await this.client.query(functionReference, args)) as T;
    } catch (error: unknown) {
      restoreQuoteDomainError(error);
    }
  }

  private async mutation<T>(
    functionReference: Parameters<ConvexClientLike["mutation"]>[0],
    args: Record<string, unknown>,
  ): Promise<T> {
    try {
      return (await this.client.mutation(functionReference, args)) as T;
    } catch (error: unknown) {
      restoreQuoteDomainError(error);
    }
  }

  private revisionCommand(input: QuoteRevisionCommand): {
    serviceToken: string;
    quoteId: string;
    revision: number;
    expectedAggregateVersion: number;
    expectedRevisionVersion: number;
  } {
    return {
      serviceToken: this.serviceToken,
      quoteId: input.quoteId,
      revision: input.revision,
      expectedAggregateVersion: input.expectedAggregateVersion,
      expectedRevisionVersion: input.expectedRevisionVersion,
    };
  }
}
