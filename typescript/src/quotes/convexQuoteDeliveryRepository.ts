import { ConvexHttpClient } from "convex/browser";

import { api } from "../../convex/_generated/api.js";
import type { ConvexClientLike } from "../persistence/convexPersistence.js";
import type { QuoteDeliveryAttempt } from "./quoteLifecycle.js";
import type {
  BindQuoteProviderReferenceInput,
  CompleteQuoteDeliveryInput,
  CreateQuoteDeliveryInput,
  MarkQuoteDeliveryIndeterminateInput,
  QuoteDeliveryRepository,
  QuoteSendScope,
  ReconcileQuoteDeliveryInput,
  StartQuoteDeliveryInput,
} from "./quoteDeliveryRepository.js";

export const quoteDeliveryFunctions = api.quoteDelivery;

type DeliveryDoc = QuoteDeliveryAttempt & { _id: string; _creationTime: number };

function deliveryFromDoc(doc: DeliveryDoc): QuoteDeliveryAttempt {
  return {
    deliveryAttemptId: doc.deliveryAttemptId,
    ownerId: doc.ownerId,
    quoteId: doc.quoteId,
    revision: doc.revision,
    revisionId: doc.revisionId,
    revisionFingerprint: doc.revisionFingerprint,
    recipient: doc.recipient,
    channel: doc.channel,
    sendFingerprint: doc.sendFingerprint,
    idempotencyKey: doc.idempotencyKey,
    approvalId: doc.approvalId,
    actionFingerprint: doc.actionFingerprint,
    status: doc.status,
    ...(doc.reconciledOutcome === undefined ? {} : { reconciledOutcome: doc.reconciledOutcome }),
    provider: doc.provider,
    ...(doc.providerRequestId === undefined ? {} : { providerRequestId: doc.providerRequestId }),
    ...(doc.providerCorrelationId === undefined
      ? {}
      : { providerCorrelationId: doc.providerCorrelationId }),
    ...(doc.reconciliationId === undefined ? {} : { reconciliationId: doc.reconciliationId }),
    ...(doc.providerErrorCode === undefined ? {} : { providerErrorCode: doc.providerErrorCode }),
    createdAt: doc.createdAt,
    ...(doc.executionStartedAt === undefined ? {} : { executionStartedAt: doc.executionStartedAt }),
    ...(doc.completedAt === undefined ? {} : { completedAt: doc.completedAt }),
    ...(doc.reconciledAt === undefined ? {} : { reconciledAt: doc.reconciledAt }),
    updatedAt: doc.updatedAt,
  };
}

/**
 * Convex-backed {@link QuoteDeliveryRepository}. Every transition is guarded
 * server-side by the delivery attempt's current status (see
 * `convex/quoteDeliveryValidators.ts`), so this adapter only maps between the
 * domain input/output types and the Convex function signatures and never
 * re-implements a state-machine rule the server owns.
 */
export class ConvexQuoteDeliveryRepository implements QuoteDeliveryRepository {
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

  async getBySendScope(input: QuoteSendScope): Promise<QuoteDeliveryAttempt | null> {
    const doc = (await this.client.query(quoteDeliveryFunctions.getBySendScope, {
      serviceToken: this.serviceToken,
      quoteId: input.quoteId,
      revision: input.revision,
      recipient: input.recipient,
      channel: input.channel,
    })) as DeliveryDoc | null;
    return doc === null ? null : deliveryFromDoc(doc);
  }

  async createPending(input: CreateQuoteDeliveryInput): Promise<QuoteDeliveryAttempt> {
    const doc = (await this.client.mutation(quoteDeliveryFunctions.createPending, {
      serviceToken: this.serviceToken,
      quoteId: input.quoteId,
      revision: input.revision,
      recipient: input.recipient,
      channel: input.channel,
      revisionId: input.revisionId,
      revisionFingerprint: input.revisionFingerprint,
      sendFingerprint: input.sendFingerprint,
      idempotencyKey: input.idempotencyKey,
      approvalId: input.approvalId,
      actionFingerprint: input.actionFingerprint,
      provider: input.provider,
    })) as DeliveryDoc;
    return deliveryFromDoc(doc);
  }

  async markExecuting(input: StartQuoteDeliveryInput): Promise<QuoteDeliveryAttempt> {
    const doc = (await this.client.mutation(quoteDeliveryFunctions.markExecuting, {
      serviceToken: this.serviceToken,
      deliveryAttemptId: input.deliveryAttemptId,
    })) as DeliveryDoc;
    return deliveryFromDoc(doc);
  }

  async bindProviderReference(
    input: BindQuoteProviderReferenceInput,
  ): Promise<QuoteDeliveryAttempt> {
    const doc = (await this.client.mutation(quoteDeliveryFunctions.bindProviderReference, {
      serviceToken: this.serviceToken,
      deliveryAttemptId: input.deliveryAttemptId,
      providerRequestId: input.providerRequestId,
      ...(input.providerCorrelationId === undefined
        ? {}
        : { providerCorrelationId: input.providerCorrelationId }),
      ...(input.reconciliationId === undefined ? {} : { reconciliationId: input.reconciliationId }),
    })) as DeliveryDoc;
    return deliveryFromDoc(doc);
  }

  async complete(input: CompleteQuoteDeliveryInput): Promise<QuoteDeliveryAttempt> {
    const doc = (await this.client.mutation(quoteDeliveryFunctions.complete, {
      serviceToken: this.serviceToken,
      deliveryAttemptId: input.deliveryAttemptId,
      outcome: input.outcome,
      ...(input.providerErrorCode === undefined
        ? {}
        : { providerErrorCode: input.providerErrorCode }),
    })) as DeliveryDoc;
    return deliveryFromDoc(doc);
  }

  async markIndeterminate(
    input: MarkQuoteDeliveryIndeterminateInput,
  ): Promise<QuoteDeliveryAttempt> {
    const doc = (await this.client.mutation(quoteDeliveryFunctions.markIndeterminate, {
      serviceToken: this.serviceToken,
      deliveryAttemptId: input.deliveryAttemptId,
      reconciliationId: input.reconciliationId,
      ...(input.providerErrorCode === undefined
        ? {}
        : { providerErrorCode: input.providerErrorCode }),
    })) as DeliveryDoc;
    return deliveryFromDoc(doc);
  }

  async reconcile(input: ReconcileQuoteDeliveryInput): Promise<QuoteDeliveryAttempt> {
    const doc = (await this.client.mutation(quoteDeliveryFunctions.reconcile, {
      serviceToken: this.serviceToken,
      deliveryAttemptId: input.deliveryAttemptId,
      reconciliationId: input.reconciliationId,
      outcome: input.outcome,
      ...(input.providerErrorCode === undefined
        ? {}
        : { providerErrorCode: input.providerErrorCode }),
    })) as DeliveryDoc;
    return deliveryFromDoc(doc);
  }
}
