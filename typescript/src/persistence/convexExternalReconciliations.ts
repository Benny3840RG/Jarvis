import { ConvexHttpClient } from "convex/browser";

import { api } from "../../convex/_generated/api.js";
import type { ToolExecutionReceipt } from "../actions/toolExecution.js";
import type {
  CompleteExternalAttemptInput,
  ExternalReconciliationClaim,
  ExternalReconciliationEnvelope,
  ExternalReconciliationRecord,
  ExternalReconciliationReadStore,
  ExternalReconciliationStore,
  ExternalExecutionScope,
  MarkExternalIndeterminateInput,
  ProviderReconciliationResult,
  RegisterExternalAttemptInput,
} from "../reconciliation/externalReconciliation.js";
import type { ConvexClientLike } from "./convexPersistence.js";

export const externalReconciliationFunctions = api.externalReconciliations;

type ReconciliationRow = {
  reconciliationId: string;
  executionKey: string;
  actionId: string;
  requestId: string;
  projectId: string;
  idempotencyKey: string;
  actionFingerprint: string;
  effectFingerprint: string;
  tool: string;
  operation: string;
  provider: string;
  providerRequestId?: string;
  providerCorrelationId: string;
  receiptKey?: string;
  receiptId?: string;
  state: "observing" | "pending" | "claimed" | "resolved" | "escalated";
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
};

type ReceiptRow = {
  receiptId: string;
  actionId: string;
  requestId?: string;
  projectId: string;
  idempotencyKey: string;
  actionFingerprint: string;
  effectFingerprint?: string;
  tool: string;
  operation: string;
  actor?: "user" | "agent" | "tool";
  approvalId?: string;
  policyVersion?: string;
  correlationId?: string;
  source?: string;
  provider?: string;
  providerRequestId?: string;
  providerCorrelationId?: string;
  reconciliationId?: string;
  status: ToolExecutionReceipt["status"];
  outputDigest?: string;
  errorCode?: ToolExecutionReceipt["errorCode"];
  providerErrorCode?: string;
  startedAt: number;
  completedAt: number;
};

function reconciliationFromConvex(
  row: ReconciliationRow,
): ExternalReconciliationRecord {
  return {
    reconciliationId: row.reconciliationId,
    executionKey: row.executionKey,
    actionId: row.actionId,
    requestId: row.requestId,
    projectId: row.projectId,
    idempotencyKey: row.idempotencyKey,
    actionFingerprint: row.actionFingerprint,
    effectFingerprint: row.effectFingerprint,
    tool: row.tool,
    operation: row.operation,
    provider: row.provider,
    ...(row.providerRequestId === undefined
      ? {}
      : { providerRequestId: row.providerRequestId }),
    providerCorrelationId: row.providerCorrelationId,
    ...(row.receiptKey === undefined ? {} : { receiptKey: row.receiptKey }),
    ...(row.receiptId === undefined ? {} : { receiptId: row.receiptId }),
    state: row.state,
    attemptCount: row.attemptCount,
    nextAttemptAt: row.nextAttemptAt,
    ...(row.leaseOwner === undefined ? {} : { leaseOwner: row.leaseOwner }),
    ...(row.leaseToken === undefined ? {} : { leaseToken: row.leaseToken }),
    ...(row.leaseExpiresAt === undefined
      ? {}
      : { leaseExpiresAt: row.leaseExpiresAt }),
    ...(row.terminalStatus === undefined
      ? {}
      : { terminalStatus: row.terminalStatus }),
    ...(row.resolutionDigest === undefined
      ? {}
      : { resolutionDigest: row.resolutionDigest }),
    ...(row.resolutionErrorCode === undefined
      ? {}
      : { resolutionErrorCode: row.resolutionErrorCode }),
    ...(row.lastErrorCode === undefined
      ? {}
      : { lastErrorCode: row.lastErrorCode }),
    ...(row.escalationReason === undefined
      ? {}
      : { escalationReason: row.escalationReason }),
    createdAt: row.createdAt,
    updatedAt: row.updatedAt,
    ...(row.resolvedAt === undefined ? {} : { resolvedAt: row.resolvedAt }),
    ...(row.escalatedAt === undefined ? {} : { escalatedAt: row.escalatedAt }),
  };
}

function receiptFromConvex(row: ReceiptRow): ToolExecutionReceipt {
  return {
    receiptId: row.receiptId,
    actionId: row.actionId,
    requestId: row.requestId ?? row.actionId,
    projectId: row.projectId,
    idempotencyKey: row.idempotencyKey,
    actionFingerprint: row.actionFingerprint,
    ...(row.effectFingerprint === undefined
      ? {}
      : { effectFingerprint: row.effectFingerprint }),
    tool: row.tool,
    operation: row.operation,
    actor: row.actor ?? "tool",
    ...(row.approvalId === undefined ? {} : { approvalId: row.approvalId }),
    policyVersion: row.policyVersion ?? "legacy-unversioned",
    correlationId: row.correlationId ?? row.requestId ?? row.actionId,
    source: row.source ?? "convex-external-reconciliation",
    ...(row.provider === undefined ? {} : { provider: row.provider }),
    ...(row.providerRequestId === undefined
      ? {}
      : { providerRequestId: row.providerRequestId }),
    ...(row.providerCorrelationId === undefined
      ? {}
      : { providerCorrelationId: row.providerCorrelationId }),
    ...(row.reconciliationId === undefined
      ? {}
      : { reconciliationId: row.reconciliationId }),
    status: row.status,
    ...(row.outputDigest === undefined
      ? {}
      : { outputDigest: row.outputDigest }),
    ...(row.errorCode === undefined ? {} : { errorCode: row.errorCode }),
    ...(row.providerErrorCode === undefined
      ? {}
      : { providerErrorCode: row.providerErrorCode }),
    startedAt: new Date(row.startedAt).toISOString(),
    completedAt: new Date(row.completedAt).toISOString(),
  } as ToolExecutionReceipt;
}

function envelopeFromConvex(row: {
  reconciliation: ReconciliationRow;
  receipt: ReceiptRow | null;
}): ExternalReconciliationEnvelope {
  return {
    reconciliation: reconciliationFromConvex(row.reconciliation),
    receipt: row.receipt === null ? null : receiptFromConvex(row.receipt),
  };
}

function receiptInput(receipt: ToolExecutionReceipt) {
  return {
    receiptId: receipt.receiptId,
    actionId: receipt.actionId,
    requestId: receipt.requestId,
    projectId: receipt.projectId,
    idempotencyKey: receipt.idempotencyKey,
    actionFingerprint: receipt.actionFingerprint,
    ...(receipt.effectFingerprint === undefined
      ? {}
      : { effectFingerprint: receipt.effectFingerprint }),
    tool: receipt.tool,
    operation: receipt.operation,
    actor: receipt.actor,
    ...(receipt.approvalId === undefined
      ? {}
      : { approvalId: receipt.approvalId }),
    policyVersion: receipt.policyVersion,
    correlationId: receipt.correlationId,
    source: receipt.source,
    ...(receipt.provider === undefined ? {} : { provider: receipt.provider }),
    ...(receipt.providerRequestId === undefined
      ? {}
      : { providerRequestId: receipt.providerRequestId }),
    ...(receipt.providerCorrelationId === undefined
      ? {}
      : { providerCorrelationId: receipt.providerCorrelationId }),
    ...(receipt.reconciliationId === undefined
      ? {}
      : { reconciliationId: receipt.reconciliationId }),
    status: receipt.status,
    ...(receipt.outputDigest === undefined
      ? {}
      : { outputDigest: receipt.outputDigest }),
    ...(receipt.errorCode === undefined
      ? {}
      : { errorCode: receipt.errorCode }),
    ...(receipt.providerErrorCode === undefined
      ? {}
      : { providerErrorCode: receipt.providerErrorCode }),
    startedAt: new Date(receipt.startedAt).getTime(),
    completedAt: new Date(receipt.completedAt).getTime(),
  };
}

function scopeArgs(scope: ExternalExecutionScope) {
  return {
    projectId: scope.projectId,
    tool: scope.tool,
    operation: scope.operation,
    idempotencyKey: scope.idempotencyKey,
    effectFingerprint: scope.effectFingerprint,
  };
}

export class ConvexExternalReconciliationStore
  implements ExternalReconciliationStore, ExternalReconciliationReadStore
{
  private readonly client: ConvexClientLike;
  private readonly serviceToken: string;
  private readonly deployment: string;

  constructor(
    client?: ConvexClientLike,
    serviceToken = process.env.JARVIS_SERVICE_TOKEN,
    deployment = process.env.CONVEX_DEPLOYMENT,
  ) {
    if (!serviceToken)
      throw new Error("External reconciliation requires JARVIS_SERVICE_TOKEN.");
    this.serviceToken = serviceToken;
    this.deployment = deployment ?? "";

    if (client) {
      this.client = client;
      return;
    }
    const convexUrl = process.env.CONVEX_URL;
    if (!convexUrl)
      throw new Error("External reconciliation requires CONVEX_URL.");
    this.client = new ConvexHttpClient(convexUrl);
  }

  async getByScope(
    scope: ExternalExecutionScope,
  ): Promise<ExternalReconciliationEnvelope | null> {
    const row = await this.client.query(
      externalReconciliationFunctions.getByScope,
      {
        serviceToken: this.serviceToken,
        ...scopeArgs(scope),
      },
    );
    return row === null
      ? null
      : envelopeFromConvex(
          row as {
            reconciliation: ReconciliationRow;
            receipt: ReceiptRow | null;
          },
        );
  }

  async listForOperator(
    input: {
      state?: ExternalReconciliationRecord["state"];
      limit?: number;
    } = {},
  ): Promise<ExternalReconciliationRecord[]> {
    const rows = await this.client.query(
      externalReconciliationFunctions.listForOperator,
      {
        serviceToken: this.serviceToken,
        ...(input.state === undefined ? {} : { state: input.state }),
        ...(input.limit === undefined ? {} : { limit: input.limit }),
      },
    );
    return (rows as ReconciliationRow[]).map(reconciliationFromConvex);
  }

  async getForOperator(
    reconciliationId: string,
  ): Promise<ExternalReconciliationEnvelope | null> {
    const row = await this.client.query(
      externalReconciliationFunctions.getForOperator,
      {
        serviceToken: this.serviceToken,
        reconciliationId,
      },
    );
    return row === null
      ? null
      : envelopeFromConvex(
          row as {
            reconciliation: ReconciliationRow;
            receipt: ReceiptRow | null;
          },
        );
  }

  async registerAttempt(
    input: RegisterExternalAttemptInput,
  ): Promise<ExternalReconciliationRecord> {
    const row = await this.client.mutation(
      externalReconciliationFunctions.registerAttempt,
      {
        serviceToken: this.serviceToken,
        ...scopeArgs(input),
        reconciliationId: input.reconciliationId,
        executionKey: input.executionKey,
        actionId: input.actionId,
        requestId: input.requestId,
        actionFingerprint: input.actionFingerprint,
        provider: input.reference.provider,
        providerRequestId: input.reference.providerRequestId,
        providerCorrelationId: input.reference.providerCorrelationId,
      },
    );
    return reconciliationFromConvex(row as ReconciliationRow);
  }

  async markIndeterminate(
    input: MarkExternalIndeterminateInput,
  ): Promise<ExternalReconciliationEnvelope> {
    const row = await this.client.mutation(
      externalReconciliationFunctions.markIndeterminate,
      {
        serviceToken: this.serviceToken,
        ...scopeArgs(input),
        reconciliationId: input.reconciliationId,
        executionKey: input.executionKey,
        actionId: input.actionId,
        requestId: input.requestId,
        actionFingerprint: input.actionFingerprint,
        expectedProvider: input.expectedProvider,
        receiptKey: input.receiptKey,
        receipt: receiptInput(input.receipt),
        ...(input.missingReferenceReason === undefined
          ? {}
          : { missingReferenceReason: input.missingReferenceReason }),
      },
    );
    return envelopeFromConvex(
      row as {
        reconciliation: ReconciliationRow;
        receipt: ReceiptRow | null;
      },
    );
  }

  async completeAttempt(
    input: CompleteExternalAttemptInput,
  ): Promise<ExternalReconciliationEnvelope> {
    const row = await this.client.mutation(
      externalReconciliationFunctions.completeAttempt,
      {
        serviceToken: this.serviceToken,
        ...scopeArgs(input),
        reconciliationId: input.reconciliationId,
        executionKey: input.executionKey,
        actionId: input.actionId,
        requestId: input.requestId,
        actionFingerprint: input.actionFingerprint,
        expectedProvider: input.expectedProvider,
        receiptKey: input.receiptKey,
        receipt: receiptInput(input.receipt),
      },
    );
    return envelopeFromConvex(
      row as {
        reconciliation: ReconciliationRow;
        receipt: ReceiptRow | null;
      },
    );
  }

  async claimNext(input: {
    workerId: string;
    leaseToken: string;
    now: number;
    leaseMs: number;
  }): Promise<ExternalReconciliationClaim | null> {
    const row = await this.client.mutation(
      externalReconciliationFunctions.claimNext,
      {
        serviceToken: this.serviceToken,
        ...input,
      },
    );
    if (row === null) return null;
    const mapped = envelopeFromConvex(
      row as {
        reconciliation: ReconciliationRow;
        receipt: ReceiptRow;
      },
    );
    if (
      mapped.receipt === null ||
      mapped.reconciliation.state !== "claimed" ||
      mapped.reconciliation.leaseOwner === undefined ||
      mapped.reconciliation.leaseToken === undefined ||
      mapped.reconciliation.leaseExpiresAt === undefined
    ) {
      throw new Error("Convex returned an incomplete reconciliation claim.");
    }
    return {
      reconciliation: {
        ...mapped.reconciliation,
        state: "claimed",
        leaseOwner: mapped.reconciliation.leaseOwner,
        leaseToken: mapped.reconciliation.leaseToken,
        leaseExpiresAt: mapped.reconciliation.leaseExpiresAt,
      },
      receipt: mapped.receipt,
    };
  }

  async resolveClaim(input: {
    reconciliationId: string;
    workerId: string;
    leaseToken: string;
    now: number;
    result: Exclude<ProviderReconciliationResult, { status: "unresolved" }>;
  }): Promise<ToolExecutionReceipt> {
    const row = await this.client.mutation(
      externalReconciliationFunctions.resolveClaim,
      {
        serviceToken: this.serviceToken,
        ...input,
      },
    );
    return receiptFromConvex(row as ReceiptRow);
  }

  async releaseClaim(input: {
    reconciliationId: string;
    workerId: string;
    leaseToken: string;
    now: number;
    errorCode: string;
    nextAttemptAt: number;
    maxAttempts: number;
  }): Promise<ExternalReconciliationRecord> {
    const row = await this.client.mutation(
      externalReconciliationFunctions.releaseClaim,
      {
        serviceToken: this.serviceToken,
        ...input,
      },
    );
    return reconciliationFromConvex(row as ReconciliationRow);
  }

  async cleanup(reconciliationId: string): Promise<boolean> {
    return this.client.mutation(externalReconciliationFunctions.cleanup, {
      serviceToken: this.serviceToken,
      reconciliationId,
      deployment: this.deployment,
    });
  }
}
