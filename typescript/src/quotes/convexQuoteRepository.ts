import { ConvexHttpClient } from "convex/browser";

import { api } from "../../convex/_generated/api.js";
import type { ConvexClientLike } from "../persistence/convexPersistence.js";
import type { QuoteAggregate, QuoteRevision, QuoteSnapshot } from "./quoteLifecycle.js";
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

  constructor(client?: ConvexClientLike, serviceToken = process.env.JARVIS_SERVICE_TOKEN) {
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
    const doc = (await this.client.mutation(quoteFunctions.create, {
      serviceToken: this.serviceToken,
      clientId: input.clientId,
      ...(input.projectId === undefined ? {} : { projectId: input.projectId }),
      number: input.number,
      lineItems: input.lineItems,
      ...(input.taxRate === undefined ? {} : { taxRate: input.taxRate }),
      ...(input.validUntil === undefined ? {} : { validUntil: input.validUntil }),
      ...(input.notes === undefined ? {} : { notes: input.notes }),
      termsIncluded: input.termsIncluded,
    })) as SnapshotDoc;
    return snapshotFromDoc(doc);
  }

  async getQuote(quoteId: string): Promise<QuoteSnapshot | null> {
    const doc = (await this.client.query(quoteFunctions.get, {
      serviceToken: this.serviceToken,
      quoteId,
    })) as SnapshotDoc | null;
    return doc === null ? null : snapshotFromDoc(doc);
  }

  async listQuotes(input: ListQuotesInput): Promise<QuoteSummary[]> {
    const docs = (await this.client.query(quoteFunctions.list, {
      serviceToken: this.serviceToken,
      ...(input.clientId === undefined ? {} : { clientId: input.clientId }),
      ...(input.projectId === undefined ? {} : { projectId: input.projectId }),
      ...(input.commercialStatus === undefined ? {} : { commercialStatus: input.commercialStatus }),
      ...(input.limit === undefined ? {} : { limit: input.limit }),
    })) as SnapshotDoc[];
    return docs.map(summaryFromDoc);
  }

  async updateDraft(input: UpdateQuoteDraftInput): Promise<QuoteSnapshot> {
    const doc = (await this.client.mutation(quoteFunctions.updateDraft, {
      serviceToken: this.serviceToken,
      quoteId: input.quoteId,
      revision: input.revision,
      expectedAggregateVersion: input.expectedAggregateVersion,
      expectedRevisionVersion: input.expectedRevisionVersion,
      patch: input.patch,
    })) as SnapshotDoc;
    return snapshotFromDoc(doc);
  }

  async submitForReview(input: QuoteRevisionCommand): Promise<QuoteSnapshot> {
    return snapshotFromDoc(
      (await this.client.mutation(
        quoteFunctions.submitForReview,
        this.revisionCommand(input),
      )) as SnapshotDoc,
    );
  }

  async reopenForEditing(input: QuoteRevisionCommand): Promise<QuoteSnapshot> {
    return snapshotFromDoc(
      (await this.client.mutation(
        quoteFunctions.reopenForEditing,
        this.revisionCommand(input),
      )) as SnapshotDoc,
    );
  }

  async finalizeRevision(input: FinalizeQuoteRevisionInput): Promise<QuoteSnapshot> {
    return snapshotFromDoc(
      (await this.client.mutation(
        quoteFunctions.finalizeRevision,
        this.revisionCommand(input),
      )) as SnapshotDoc,
    );
  }

  async createRevisionFromFinalized(input: CreateQuoteRevisionInput): Promise<QuoteSnapshot> {
    const doc = (await this.client.mutation(quoteFunctions.forkRevision, {
      ...this.revisionCommand(input),
      expectedFingerprint: input.expectedFingerprint,
    })) as SnapshotDoc;
    return snapshotFromDoc(doc);
  }

  async recordCommercialOutcome(input: RecordQuoteCommercialOutcomeInput): Promise<QuoteSnapshot> {
    const doc = (await this.client.mutation(quoteFunctions.recordCommercialOutcome, {
      serviceToken: this.serviceToken,
      quoteId: input.quoteId,
      revision: input.revision,
      expectedAggregateVersion: input.expectedAggregateVersion,
      outcome: input.outcome,
    })) as SnapshotDoc;
    return snapshotFromDoc(doc);
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
