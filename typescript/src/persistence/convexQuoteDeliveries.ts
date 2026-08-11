import { ConvexHttpClient } from "convex/browser";

import { api } from "../../convex/_generated/api.js";
import type { ConvexClientLike } from "./convexPersistence.js";
import type {
  BindQuoteProviderReferenceInput,
  CompleteQuoteDeliveryInput,
  CreateQuoteDeliveryInput,
  ListQuoteDeliveriesInput,
  MarkQuoteDeliveryIndeterminateInput,
  QuoteDeliveryAttempt,
  QuoteDeliveryRepository,
  QuoteSendScope,
  ReconcileQuoteDeliveryInput,
  StartQuoteDeliveryInput,
} from "../quotes/quoteDeliveryRepository.js";

export const quoteDeliveryFunctions = api.quoteDeliveries;

type AttemptDoc = QuoteDeliveryAttempt & { _id: string; _creationTime: number };

export type ConvexQuoteDeliveryRepositoryOptions = {
  client: ConvexClientLike;
  serviceToken: string;
  deliveryRuntimeToken: string;
  deployment?: string;
};

function attemptFromDoc(doc: AttemptDoc): QuoteDeliveryAttempt {
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

function isConvexClient(
  value: ConvexQuoteDeliveryRepositoryOptions | ConvexClientLike | undefined,
): value is ConvexClientLike {
  return (
    value !== undefined && typeof value === "object" && "query" in value && "mutation" in value
  );
}

/**
 * Convex-backed {@link QuoteDeliveryRepository}. A quote-scoped, queryable
 * projection of delivery state — the actual no-blind-retry / exactly-once
 * guarantees are owned by `ToolExecutionService` and `ExternalReconciliationStore`
 * (see `src/actions/toolExecution.ts`); this store never re-implements those,
 * it only records the same lifecycle transitions in a shape indexed by
 * owner+quote+revision so `GET /api/v1/quotes/:id/deliveries` can list them.
 */
export class ConvexQuoteDeliveryRepository implements QuoteDeliveryRepository {
  private readonly client: ConvexClientLike;
  private readonly serviceToken: string;
  private readonly deliveryRuntimeToken: string;
  private readonly deployment: string;

  constructor(options: ConvexQuoteDeliveryRepositoryOptions);
  constructor(client?: ConvexClientLike, serviceToken?: string, deployment?: string);
  constructor(
    optionsOrClient?: ConvexQuoteDeliveryRepositoryOptions | ConvexClientLike,
    legacyServiceToken?: string,
    legacyDeployment?: string,
  ) {
    let client: ConvexClientLike | undefined;
    let serviceToken: string | undefined;
    let deliveryRuntimeToken: string | undefined;
    let deployment: string | undefined;

    if (isConvexClient(optionsOrClient) || optionsOrClient === undefined) {
      client = optionsOrClient;
      serviceToken = legacyServiceToken ?? process.env.JARVIS_SERVICE_TOKEN;
      deliveryRuntimeToken = process.env.JARVIS_DELIVERY_RUNTIME_TOKEN;
      deployment = legacyDeployment ?? process.env.CONVEX_DEPLOYMENT;
    } else {
      client = optionsOrClient.client;
      serviceToken = optionsOrClient.serviceToken;
      deliveryRuntimeToken = optionsOrClient.deliveryRuntimeToken;
      deployment = optionsOrClient.deployment ?? process.env.CONVEX_DEPLOYMENT;
    }

    if (!serviceToken) {
      throw new Error(
        "PERSISTENCE_PROVIDER=convex requires JARVIS_SERVICE_TOKEN. The deployment URL is not authentication.",
      );
    }
    this.serviceToken = serviceToken;
    if (!deliveryRuntimeToken) {
      throw new Error(
        "PERSISTENCE_PROVIDER=convex quote delivery requires JARVIS_DELIVERY_RUNTIME_TOKEN.",
      );
    }
    this.deliveryRuntimeToken = deliveryRuntimeToken;
    this.deployment = deployment ?? "";

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
    const doc = await this.query<AttemptDoc | null>(quoteDeliveryFunctions.getBySendScope, {
      serviceToken: this.serviceToken,
      quoteId: input.quoteId,
      revision: input.revision,
      recipient: input.recipient,
      channel: input.channel,
    });
    return doc === null ? null : attemptFromDoc(doc);
  }

  async createPending(input: CreateQuoteDeliveryInput): Promise<QuoteDeliveryAttempt> {
    const doc = await this.mutation<AttemptDoc>(quoteDeliveryFunctions.createPending, {
      serviceToken: this.serviceToken,
      deliveryRuntimeToken: this.deliveryRuntimeToken,
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
    });
    return attemptFromDoc(doc);
  }

  async markExecuting(input: StartQuoteDeliveryInput): Promise<QuoteDeliveryAttempt> {
    const doc = await this.mutation<AttemptDoc>(quoteDeliveryFunctions.markExecuting, {
      serviceToken: this.serviceToken,
      deliveryRuntimeToken: this.deliveryRuntimeToken,
      deliveryAttemptId: input.deliveryAttemptId,
      expectedStatus: input.expectedStatus,
    });
    return attemptFromDoc(doc);
  }

  async bindProviderReference(
    input: BindQuoteProviderReferenceInput,
  ): Promise<QuoteDeliveryAttempt> {
    const doc = await this.mutation<AttemptDoc>(quoteDeliveryFunctions.bindProviderReference, {
      serviceToken: this.serviceToken,
      deliveryRuntimeToken: this.deliveryRuntimeToken,
      deliveryAttemptId: input.deliveryAttemptId,
      expectedStatus: input.expectedStatus,
      providerRequestId: input.providerRequestId,
      ...(input.providerCorrelationId === undefined
        ? {}
        : { providerCorrelationId: input.providerCorrelationId }),
      ...(input.reconciliationId === undefined ? {} : { reconciliationId: input.reconciliationId }),
    });
    return attemptFromDoc(doc);
  }

  async complete(input: CompleteQuoteDeliveryInput): Promise<QuoteDeliveryAttempt> {
    const doc = await this.mutation<AttemptDoc>(quoteDeliveryFunctions.complete, {
      serviceToken: this.serviceToken,
      deliveryRuntimeToken: this.deliveryRuntimeToken,
      deliveryAttemptId: input.deliveryAttemptId,
      expectedStatus: input.expectedStatus,
      outcome: input.outcome,
      ...(input.providerErrorCode === undefined
        ? {}
        : { providerErrorCode: input.providerErrorCode }),
    });
    return attemptFromDoc(doc);
  }

  async markIndeterminate(
    input: MarkQuoteDeliveryIndeterminateInput,
  ): Promise<QuoteDeliveryAttempt> {
    const doc = await this.mutation<AttemptDoc>(quoteDeliveryFunctions.markIndeterminate, {
      serviceToken: this.serviceToken,
      deliveryRuntimeToken: this.deliveryRuntimeToken,
      deliveryAttemptId: input.deliveryAttemptId,
      expectedStatus: input.expectedStatus,
      reconciliationId: input.reconciliationId,
      ...(input.providerErrorCode === undefined
        ? {}
        : { providerErrorCode: input.providerErrorCode }),
    });
    return attemptFromDoc(doc);
  }

  async reconcile(input: ReconcileQuoteDeliveryInput): Promise<QuoteDeliveryAttempt> {
    const doc = await this.mutation<AttemptDoc>(quoteDeliveryFunctions.reconcile, {
      serviceToken: this.serviceToken,
      deliveryRuntimeToken: this.deliveryRuntimeToken,
      deliveryAttemptId: input.deliveryAttemptId,
      expectedStatus: input.expectedStatus,
      reconciliationId: input.reconciliationId,
      outcome: input.outcome,
      ...(input.providerErrorCode === undefined
        ? {}
        : { providerErrorCode: input.providerErrorCode }),
    });
    return attemptFromDoc(doc);
  }

  async listForQuote(input: ListQuoteDeliveriesInput): Promise<QuoteDeliveryAttempt[]> {
    const docs = await this.query<AttemptDoc[]>(quoteDeliveryFunctions.listForQuote, {
      serviceToken: this.serviceToken,
      quoteId: input.quoteId,
      ...(input.revision === undefined ? {} : { revision: input.revision }),
    });
    return docs.map(attemptFromDoc);
  }

  async cleanup(quoteId: string): Promise<boolean> {
    return this.mutation<boolean>(quoteDeliveryFunctions.cleanup, {
      serviceToken: this.serviceToken,
      deliveryRuntimeToken: this.deliveryRuntimeToken,
      quoteId,
      deployment: this.deployment,
    });
  }

  private async query<T>(
    functionReference: Parameters<ConvexClientLike["query"]>[0],
    args: Record<string, unknown>,
  ): Promise<T> {
    return (await this.client.query(functionReference, args)) as T;
  }

  private async mutation<T>(
    functionReference: Parameters<ConvexClientLike["mutation"]>[0],
    args: Record<string, unknown>,
  ): Promise<T> {
    return (await this.client.mutation(functionReference, args)) as T;
  }
}
