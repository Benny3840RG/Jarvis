import type { ToolExecutionReceipt } from "../actions/toolExecution.js";
import type { SafetyBinding } from "../safety/safetyBinder.js";

export const EXTERNAL_RECONCILIATION_STATES = [
  "observing",
  "pending",
  "claimed",
  "resolved",
  "escalated",
] as const;
export type ExternalReconciliationState = (typeof EXTERNAL_RECONCILIATION_STATES)[number];

export type ExternalExecutionScope = {
  projectId: string;
  tool: string;
  operation: string;
  idempotencyKey: string;
  effectFingerprint: string;
};

export type ProviderAttemptReference = {
  provider: string;
  providerRequestId: string;
  providerCorrelationId: string;
};

export type ExternalReconciliationRecord = ExternalExecutionScope & {
  reconciliationId: string;
  executionKey: string;
  actionId: string;
  requestId: string;
  actionFingerprint: string;
  provider: string;
  providerRequestId?: string;
  providerCorrelationId: string;
  receiptKey?: string;
  receiptId?: string;
  state: ExternalReconciliationState;
  attemptCount: number;
  nextAttemptAt: number;
  leaseOwner?: string;
  leaseToken?: string;
  leaseExpiresAt?: number;
  terminalStatus?: "succeeded" | "failed";
  resolutionDigest?: string;
  resolutionErrorCode?: string;
  lastErrorCode?: string;
  escalationReason?: string;
  createdAt: number;
  updatedAt: number;
  resolvedAt?: number;
  escalatedAt?: number;
  safetyBinding?: SafetyBinding;
};

export type ExternalReconciliationEnvelope = {
  reconciliation: ExternalReconciliationRecord;
  receipt: ToolExecutionReceipt | null;
};

export type ExternalReconciliationClaim = {
  reconciliation: ExternalReconciliationRecord & {
    state: "claimed";
    leaseOwner: string;
    leaseToken: string;
    leaseExpiresAt: number;
  };
  receipt: ToolExecutionReceipt;
};

export type ProviderReconciliationResult =
  | {
      status: "succeeded";
      outputDigest?: string;
    }
  | {
      status: "failed";
      errorCode: string;
    }
  | {
      status: "unresolved";
      errorCode: string;
      retryAfterMs?: number;
    };

export interface ProviderReconciliationAdapter {
  readonly provider: string;
  reconcile(
    reference: ProviderAttemptReference,
    signal: AbortSignal,
  ): Promise<ProviderReconciliationResult>;
}

export type RegisterExternalAttemptInput = ExternalExecutionScope & {
  reconciliationId: string;
  executionKey: string;
  actionId: string;
  requestId: string;
  actionFingerprint: string;
  reference: ProviderAttemptReference;
  safetyBinding?: SafetyBinding;
};

export type MarkExternalIndeterminateInput = ExternalExecutionScope & {
  reconciliationId: string;
  executionKey: string;
  actionId: string;
  requestId: string;
  actionFingerprint: string;
  expectedProvider: string;
  receiptKey: string;
  receipt: ToolExecutionReceipt;
  missingReferenceReason?: string;
};

export type CompleteExternalAttemptInput = ExternalExecutionScope & {
  reconciliationId: string;
  executionKey: string;
  actionId: string;
  requestId: string;
  actionFingerprint: string;
  expectedProvider: string;
  receiptKey: string;
  receipt: ToolExecutionReceipt;
};

export type ExternalReconciliationListInput = {
  state?: ExternalReconciliationRecord["state"];
  limit?: number;
};

export interface ExternalReconciliationReadStore {
  listForOperator(input?: ExternalReconciliationListInput): Promise<ExternalReconciliationRecord[]>;
  getForOperator(reconciliationId: string): Promise<ExternalReconciliationEnvelope | null>;
}

export interface ExternalReconciliationStore {
  getByScope(scope: ExternalExecutionScope): Promise<ExternalReconciliationEnvelope | null>;
  registerAttempt(input: RegisterExternalAttemptInput): Promise<ExternalReconciliationRecord>;
  markIndeterminate(input: MarkExternalIndeterminateInput): Promise<ExternalReconciliationEnvelope>;
  completeAttempt(input: CompleteExternalAttemptInput): Promise<ExternalReconciliationEnvelope>;
  claimNext(input: {
    workerId: string;
    leaseToken: string;
    now: number;
    leaseMs: number;
  }): Promise<ExternalReconciliationClaim | null>;
  resolveClaim(input: {
    reconciliationId: string;
    workerId: string;
    leaseToken: string;
    now: number;
    result: Exclude<ProviderReconciliationResult, { status: "unresolved" }>;
  }): Promise<ToolExecutionReceipt>;
  releaseClaim(input: {
    reconciliationId: string;
    workerId: string;
    leaseToken: string;
    now: number;
    errorCode: string;
    nextAttemptAt: number;
    maxAttempts: number;
  }): Promise<ExternalReconciliationRecord>;
  cleanup(reconciliationId: string): Promise<boolean>;
}

export function externalExecutionScopeKey(
  scope: Omit<ExternalExecutionScope, "effectFingerprint">,
): string {
  return [scope.projectId, scope.tool, scope.operation, scope.idempotencyKey]
    .map((value) => `${value.length}:${value}`)
    .join("|");
}

export function providerReferenceFromRecord(
  record: ExternalReconciliationRecord,
): ProviderAttemptReference | null {
  if (!record.providerRequestId) return null;
  return {
    provider: record.provider,
    providerRequestId: record.providerRequestId,
    providerCorrelationId: record.providerCorrelationId,
  };
}
