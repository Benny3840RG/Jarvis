import type { QuoteDeliveryAttempt } from "./quoteLifecycle.js";

export type QuoteSendScope = {
  quoteId: string;
  revision: number;
  recipient: string;
  channel: "email";
};

export type CreateQuoteDeliveryInput = QuoteSendScope & {
  revisionId: string;
  revisionFingerprint: string;
  sendFingerprint: string;
  idempotencyKey: string;
  approvalId: string;
  actionFingerprint: string;
  provider: string;
  createdAt?: number;
};

export type StartQuoteDeliveryInput = {
  deliveryAttemptId: string;
  expectedStatus: "pending";
  startedAt?: number;
};

export type BindQuoteProviderReferenceInput = {
  deliveryAttemptId: string;
  expectedStatus: "executing";
  providerRequestId: string;
  providerCorrelationId?: string;
  reconciliationId?: string;
  updatedAt?: number;
};

export type CompleteQuoteDeliveryInput = {
  deliveryAttemptId: string;
  expectedStatus: "executing";
  outcome: "succeeded" | "failed";
  providerErrorCode?: string;
  completedAt?: number;
};

export type MarkQuoteDeliveryIndeterminateInput = {
  deliveryAttemptId: string;
  expectedStatus: "executing";
  reconciliationId: string;
  providerErrorCode?: string;
  updatedAt?: number;
};

export type ReconcileQuoteDeliveryInput = {
  deliveryAttemptId: string;
  expectedStatus: "indeterminate";
  reconciliationId: string;
  outcome: "succeeded" | "failed";
  providerErrorCode?: string;
  reconciledAt?: number;
};

export interface QuoteDeliveryRepository {
  getBySendScope(input: QuoteSendScope): Promise<QuoteDeliveryAttempt | null>;
  createPending(input: CreateQuoteDeliveryInput): Promise<QuoteDeliveryAttempt>;
  markExecuting(input: StartQuoteDeliveryInput): Promise<QuoteDeliveryAttempt>;
  bindProviderReference(input: BindQuoteProviderReferenceInput): Promise<QuoteDeliveryAttempt>;
  complete(input: CompleteQuoteDeliveryInput): Promise<QuoteDeliveryAttempt>;
  markIndeterminate(input: MarkQuoteDeliveryIndeterminateInput): Promise<QuoteDeliveryAttempt>;
  reconcile(input: ReconcileQuoteDeliveryInput): Promise<QuoteDeliveryAttempt>;
}
