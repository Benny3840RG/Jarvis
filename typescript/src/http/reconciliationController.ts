import { Controller, Get, Inject, Param, Query } from "@nestjs/common";

import type { ToolExecutionReceipt } from "../actions/toolExecution.js";
import type {
  ExternalReconciliationEnvelope,
  ExternalReconciliationReadStore,
  ExternalReconciliationRecord,
} from "../reconciliation/externalReconciliation.js";
import { JarvisProblem } from "./problemDetails.js";
import { parseReconciliationLimit, parseReconciliationState } from "./reconciliationRequest.js";
import { HTTP_EXTERNAL_RECONCILIATION_READ_STORE } from "./tokens.js";

function unavailable(): JarvisProblem {
  return new JarvisProblem(
    503,
    "reconciliation-read-unavailable",
    "Reconciliation Read Unavailable",
    "Reconciliation inspection requires the configured Convex persistence provider.",
  );
}

function notFound(): JarvisProblem {
  return new JarvisProblem(
    404,
    "reconciliation-not-found",
    "Reconciliation Not Found",
    "The requested reconciliation record does not exist.",
  );
}

function invalid(): JarvisProblem {
  return new JarvisProblem(
    422,
    "invalid-reconciliation-query",
    "Invalid Reconciliation Query",
    "Reconciliation state and limit parameters must match the supported contract.",
  );
}

function recordResponse(record: ExternalReconciliationRecord) {
  return {
    reconciliationId: record.reconciliationId,
    actionId: record.actionId,
    requestId: record.requestId,
    projectId: record.projectId,
    tool: record.tool,
    operation: record.operation,
    provider: record.provider,
    ...(record.providerRequestId === undefined
      ? {}
      : { providerRequestId: record.providerRequestId }),
    providerCorrelationId: record.providerCorrelationId,
    ...(record.receiptId === undefined ? {} : { receiptId: record.receiptId }),
    state: record.state,
    attemptCount: record.attemptCount,
    nextAttemptAt: record.nextAttemptAt,
    ...(record.terminalStatus === undefined ? {} : { terminalStatus: record.terminalStatus }),
    ...(record.resolutionErrorCode === undefined
      ? {}
      : { resolutionErrorCode: record.resolutionErrorCode }),
    ...(record.lastErrorCode === undefined ? {} : { lastErrorCode: record.lastErrorCode }),
    ...(record.escalationReason === undefined
      ? {}
      : { escalationReason: record.escalationReason }),
    createdAt: record.createdAt,
    updatedAt: record.updatedAt,
    ...(record.resolvedAt === undefined ? {} : { resolvedAt: record.resolvedAt }),
    ...(record.escalatedAt === undefined ? {} : { escalatedAt: record.escalatedAt }),
  };
}

function receiptResponse(receipt: ToolExecutionReceipt) {
  return {
    receiptId: receipt.receiptId,
    actionId: receipt.actionId,
    requestId: receipt.requestId,
    projectId: receipt.projectId,
    tool: receipt.tool,
    operation: receipt.operation,
    actor: receipt.actor,
    ...(receipt.approvalId === undefined ? {} : { approvalId: receipt.approvalId }),
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
    ...(receipt.errorCode === undefined ? {} : { errorCode: receipt.errorCode }),
    ...(receipt.providerErrorCode === undefined
      ? {}
      : { providerErrorCode: receipt.providerErrorCode }),
    startedAt: receipt.startedAt,
    completedAt: receipt.completedAt,
  };
}

function detailResponse(envelope: ExternalReconciliationEnvelope) {
  return {
    reconciliation: recordResponse(envelope.reconciliation),
    receipt: envelope.receipt === null ? null : receiptResponse(envelope.receipt),
  };
}

@Controller("api/v1/reconciliations")
export class ReconciliationController {
  constructor(
    @Inject(HTTP_EXTERNAL_RECONCILIATION_READ_STORE)
    private readonly store: ExternalReconciliationReadStore | null,
  ) {}

  private requireStore(): ExternalReconciliationReadStore {
    if (!this.store) throw unavailable();
    return this.store;
  }

  @Get()
  async list(@Query("state") stateValue: unknown, @Query("limit") limitValue: unknown) {
    let state;
    let limit;
    try {
      state = parseReconciliationState(stateValue);
      limit = parseReconciliationLimit(limitValue);
    } catch {
      throw invalid();
    }
    const records = await this.requireStore().listForOperator({
      ...(state === undefined ? {} : { state }),
      ...(limit === undefined ? {} : { limit }),
    });
    const data = records.map(recordResponse);
    return { data, count: data.length };
  }

  @Get(":reconciliationId")
  async get(@Param("reconciliationId") reconciliationId: string) {
    const envelope = await this.requireStore().getForOperator(reconciliationId);
    if (!envelope) throw notFound();
    return detailResponse(envelope);
  }
}
