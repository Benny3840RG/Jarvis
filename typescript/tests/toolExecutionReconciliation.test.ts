import assert from "node:assert/strict";
import { describe, it } from "node:test";

import { z } from "zod";

import {
  InMemoryToolExecutionReceiptStore,
  ToolExecutionService,
  type ToolExecutionDefinition,
  type ToolExecutionReceipt,
} from "../src/actions/toolExecution.js";
import type { ToolAction } from "../src/actions/toolActions.js";
import type {
  CompleteExternalAttemptInput,
  ExternalExecutionScope,
  ExternalReconciliationClaim,
  ExternalReconciliationEnvelope,
  ExternalReconciliationRecord,
  ExternalReconciliationStore,
  MarkExternalIndeterminateInput,
  ProviderReconciliationResult,
  RegisterExternalAttemptInput,
} from "../src/reconciliation/externalReconciliation.js";

function action(overrides: Partial<ToolAction> = {}): ToolAction {
  return {
    actionId: "action-1",
    requestId: "request-1",
    projectId: "project-1",
    baseRevision: 1,
    state: "approved",
    tool: "quotes",
    operation: "send",
    arguments: { body: "Quote body" },
    rationale: "Send the approved quote.",
    requiredAuthority: "T2",
    destructive: false,
    idempotencyKey: "proposal-1",
    proposedBy: "agent",
    approvedBy: "user",
    createdAt: "2026-07-24T00:00:00.000Z",
    updatedAt: "2026-07-24T00:00:00.000Z",
    approvedAt: "2026-07-24T00:00:00.000Z",
    ...overrides,
  };
}

class FakeReconciliationStore implements ExternalReconciliationStore {
  envelope: ExternalReconciliationEnvelope | null = null;
  readonly registerCalls: RegisterExternalAttemptInput[] = [];
  readonly markCalls: MarkExternalIndeterminateInput[] = [];
  readonly completeCalls: CompleteExternalAttemptInput[] = [];

  async getByScope(scope: ExternalExecutionScope): Promise<ExternalReconciliationEnvelope | null> {
    const current = this.envelope;
    if (!current) return null;
    const record = current.reconciliation;
    if (
      record.projectId !== scope.projectId ||
      record.tool !== scope.tool ||
      record.operation !== scope.operation ||
      record.idempotencyKey !== scope.idempotencyKey
    ) {
      return null;
    }
    if (record.effectFingerprint !== scope.effectFingerprint) {
      throw new Error("effect fingerprint collision");
    }
    return current;
  }

  async registerAttempt(input: RegisterExternalAttemptInput): Promise<ExternalReconciliationRecord> {
    this.registerCalls.push(input);
    const now = Date.now();
    const record: ExternalReconciliationRecord = {
      reconciliationId: input.reconciliationId,
      executionKey: input.executionKey,
      actionId: input.actionId,
      requestId: input.requestId,
      projectId: input.projectId,
      tool: input.tool,
      operation: input.operation,
      idempotencyKey: input.idempotencyKey,
      actionFingerprint: input.actionFingerprint,
      effectFingerprint: input.effectFingerprint,
      provider: input.reference.provider,
      providerRequestId: input.reference.providerRequestId,
      providerCorrelationId: input.reference.providerCorrelationId,
      state: "observing",
      attemptCount: 0,
      nextAttemptAt: now,
      createdAt: now,
      updatedAt: now,
    };
    this.envelope = { reconciliation: record, receipt: null };
    return record;
  }

  async markIndeterminate(
    input: MarkExternalIndeterminateInput,
  ): Promise<ExternalReconciliationEnvelope> {
    this.markCalls.push(input);
    const now = Date.now();
    const current = this.envelope?.reconciliation;
    const record: ExternalReconciliationRecord = {
      reconciliationId: input.reconciliationId,
      executionKey: input.executionKey,
      actionId: input.actionId,
      requestId: input.requestId,
      projectId: input.projectId,
      tool: input.tool,
      operation: input.operation,
      idempotencyKey: input.idempotencyKey,
      actionFingerprint: input.actionFingerprint,
      effectFingerprint: input.effectFingerprint,
      provider: input.expectedProvider,
      ...(current?.providerRequestId === undefined
        ? {}
        : { providerRequestId: current.providerRequestId }),
      providerCorrelationId:
        current?.providerCorrelationId ?? input.receipt.providerCorrelationId ?? input.receipt.correlationId,
      receiptKey: input.receiptKey,
      receiptId: input.receipt.receiptId,
      state: current?.providerRequestId ? "pending" : "escalated",
      attemptCount: current?.attemptCount ?? 0,
      nextAttemptAt: now,
      ...(current?.providerRequestId
        ? {}
        : {
            escalationReason: input.missingReferenceReason ?? "provider-reference-missing",
            escalatedAt: now,
          }),
      createdAt: current?.createdAt ?? now,
      updatedAt: now,
    };
    const receipt: ToolExecutionReceipt = {
      ...input.receipt,
      provider: input.expectedProvider,
      ...(record.providerRequestId === undefined
        ? {}
        : { providerRequestId: record.providerRequestId }),
      providerCorrelationId: record.providerCorrelationId,
      reconciliationId: record.reconciliationId,
    };
    this.envelope = { reconciliation: record, receipt };
    return this.envelope;
  }

  async completeAttempt(
    input: CompleteExternalAttemptInput,
  ): Promise<ExternalReconciliationEnvelope> {
    this.completeCalls.push(input);
    const current = this.envelope?.reconciliation;
    if (!current?.providerRequestId) throw new Error("provider reference is missing");
    const now = Date.now();
    const record: ExternalReconciliationRecord = {
      ...current,
      receiptKey: input.receiptKey,
      receiptId: input.receipt.receiptId,
      state: "resolved",
      terminalStatus: input.receipt.status as "succeeded" | "failed",
      updatedAt: now,
      resolvedAt: now,
    };
    const receipt: ToolExecutionReceipt = {
      ...input.receipt,
      provider: input.expectedProvider,
      providerRequestId: current.providerRequestId,
      providerCorrelationId: current.providerCorrelationId,
      reconciliationId: current.reconciliationId,
    };
    this.envelope = { reconciliation: record, receipt };
    return this.envelope;
  }

  async claimNext(_input: {
    workerId: string;
    leaseToken: string;
    now: number;
    leaseMs: number;
  }): Promise<ExternalReconciliationClaim | null> {
    return null;
  }

  async resolveClaim(_input: {
    reconciliationId: string;
    workerId: string;
    leaseToken: string;
    now: number;
    result: Exclude<ProviderReconciliationResult, { status: "unresolved" }>;
  }): Promise<ToolExecutionReceipt> {
    throw new Error("not used");
  }

  async releaseClaim(_input: {
    reconciliationId: string;
    workerId: string;
    leaseToken: string;
    now: number;
    errorCode: string;
    nextAttemptAt: number;
    maxAttempts: number;
  }): Promise<ExternalReconciliationRecord> {
    throw new Error("not used");
  }

  async cleanup(_reconciliationId: string): Promise<boolean> {
    this.envelope = null;
    return true;
  }
}

function externalDefinition(
  execute: ToolExecutionDefinition["execute"],
): ToolExecutionDefinition {
  return {
    tool: "quotes",
    operation: "send",
    externalProvider: "demo-provider",
    schema: z.object({ body: z.string().min(1) }),
    execute,
  };
}

describe("ToolExecutionService external reconciliation", () => {
  it("requires a reconciliation store for every external definition", () => {
    assert.throws(
      () => new ToolExecutionService([externalDefinition(async () => ({ ok: true }))]),
      /requires an ExternalReconciliationStore/,
    );
  });

  it("persists one indeterminate outcome and blocks blind retry after timeout", async () => {
    const reconciliations = new FakeReconciliationStore();
    let executions = 0;
    const definition = externalDefinition(async (_arguments, _signal, context) => {
      executions += 1;
      await context.registerProviderAttempt({
        provider: "demo-provider",
        providerRequestId: "provider-request-1",
        providerCorrelationId: "provider-correlation-1",
      });
      await new Promise<never>(() => undefined);
    });
    const service = new ToolExecutionService(
      [definition],
      new InMemoryToolExecutionReceiptStore(),
      reconciliations,
    );

    const first = await service.execute({
      action: action(),
      authority: "T2",
      idempotencyKey: "external-idempotency",
      timeoutMs: 1,
    });
    const restarted = new ToolExecutionService(
      [externalDefinition(async () => {
        executions += 1;
        return { shouldNotRun: true };
      })],
      new InMemoryToolExecutionReceiptStore(),
      reconciliations,
    );
    const replay = await restarted.execute({
      action: action({ actionId: "action-after-restart" }),
      authority: "T2",
      idempotencyKey: "external-idempotency",
    });

    assert.equal(first.status, "indeterminate");
    assert.equal(first.providerRequestId, "provider-request-1");
    assert.deepEqual(replay, first);
    assert.equal(executions, 1);
    assert.equal(reconciliations.registerCalls.length, 1);
    assert.equal(reconciliations.markCalls.length, 1);
  });

  it("blocks a changed effect under the same external idempotency scope", async () => {
    const reconciliations = new FakeReconciliationStore();
    reconciliations.envelope = {
      reconciliation: {
        reconciliationId: "reconciliation-existing",
        executionKey: "external-existing",
        actionId: "action-existing",
        requestId: "request-existing",
        projectId: "project-1",
        tool: "quotes",
        operation: "send",
        idempotencyKey: "external-idempotency",
        actionFingerprint: "action-fingerprint-existing",
        effectFingerprint: "different-effect-fingerprint",
        provider: "demo-provider",
        providerRequestId: "provider-request-existing",
        providerCorrelationId: "provider-correlation-existing",
        state: "pending",
        attemptCount: 0,
        nextAttemptAt: Date.now(),
        createdAt: Date.now(),
        updatedAt: Date.now(),
      },
      receipt: null,
    };
    let executions = 0;
    const service = new ToolExecutionService(
      [
        externalDefinition(async () => {
          executions += 1;
          return { shouldNotRun: true };
        }),
      ],
      new InMemoryToolExecutionReceiptStore(),
      reconciliations,
    );

    const result = await service.execute({
      action: action({ arguments: { body: "Changed quote body" } }),
      authority: "T2",
      idempotencyKey: "external-idempotency",
    });

    assert.equal(result.status, "blocked");
    assert.equal(result.errorCode, "fingerprint-mismatch");
    assert.equal(executions, 0);
  });

  it("never reports external success without a durable provider reference", async () => {
    const reconciliations = new FakeReconciliationStore();
    const service = new ToolExecutionService(
      [externalDefinition(async () => ({ accepted: true }))],
      new InMemoryToolExecutionReceiptStore(),
      reconciliations,
    );

    const result = await service.execute({
      action: action(),
      authority: "T2",
      idempotencyKey: "missing-reference",
    });

    assert.equal(result.status, "indeterminate");
    assert.equal(result.errorCode, "provider-reference-missing");
    assert.equal(reconciliations.completeCalls.length, 0);
    assert.equal(reconciliations.markCalls.length, 1);
    assert.equal(reconciliations.envelope?.reconciliation.state, "escalated");
  });

  it("atomically completes a registered external success", async () => {
    const reconciliations = new FakeReconciliationStore();
    const service = new ToolExecutionService(
      [
        externalDefinition(async (_arguments, _signal, context) => {
          await context.registerProviderAttempt({
            provider: "demo-provider",
            providerRequestId: "provider-request-success",
            providerCorrelationId: "provider-correlation-success",
          });
          return { accepted: true };
        }),
      ],
      new InMemoryToolExecutionReceiptStore(),
      reconciliations,
    );

    const result = await service.execute({
      action: action(),
      authority: "T2",
      idempotencyKey: "successful-external",
    });

    assert.equal(result.status, "succeeded");
    assert.equal(result.providerRequestId, "provider-request-success");
    assert.equal(reconciliations.completeCalls.length, 1);
    assert.equal(reconciliations.envelope?.reconciliation.state, "resolved");
  });
});
