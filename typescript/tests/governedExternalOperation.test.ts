import assert from "node:assert/strict";
import { describe, it } from "node:test";

import { z } from "zod";

import {
  GovernedExternalOperation,
  GovernedExternalOperationRefused,
  PolicyEngineNotAuthorityError,
  createGovernedExternalOperationFromEnv,
} from "../src/actions/governedExternalOperation.js";
import type { ToolAction, ToolActionService } from "../src/actions/toolActions.js";
import {
  InMemoryToolExecutionReceiptStore,
  ToolExecutionService,
  deriveToolExecutionIdempotencyKey,
  type ExecutionEligibilityStore,
  type SingleUseConsumptionClaimStore,
  type SingleUseExecutionClaimResult,
  type ToolExecutionDefinition,
  type ToolExecutionReceipt,
} from "../src/actions/toolExecution.js";
import type {
  CompleteExternalAttemptInput,
  ExternalExecutionScope,
  ExternalReconciliationClaim,
  ExternalReconciliationEnvelope,
  ExternalReconciliationRecord,
  ExternalReconciliationStore,
  MarkExternalIndeterminateInput,
  RegisterExternalAttemptInput,
} from "../src/reconciliation/externalReconciliation.js";

function approvedAction(overrides: Partial<ToolAction> = {}): ToolAction {
  return {
    actionId: "action-1",
    requestId: "request-1",
    projectId: "project-1",
    baseRevision: 3,
    state: "approved",
    tool: "github",
    operation: "merge-pull-request",
    arguments: { head: "abc" },
    rationale: "Merge one reviewed pull request.",
    requiredAuthority: "T3",
    destructive: true,
    idempotencyKey: "proposal-1",
    proposedBy: "agent",
    approvedBy: "user",
    consumptionPolicy: "single-use",
    approvalExpiryPolicy: "non-expiring",
    createdAt: "2026-09-23T00:00:00.000Z",
    updatedAt: "2026-09-23T00:00:00.000Z",
    approvedAt: "2026-09-23T00:00:00.000Z",
    ...overrides,
  };
}

class MemoryActions implements Pick<ToolActionService, "stage" | "get"> {
  readonly rows = new Map<string, ToolAction>();
  stageCalls = 0;

  async stage(input: Parameters<ToolActionService["stage"]>[0]): Promise<ToolAction> {
    this.stageCalls += 1;
    const staged: ToolAction = {
      actionId: input.actionId,
      requestId: input.requestId,
      projectId: input.projectId,
      baseRevision: input.expectedRevision,
      state: "proposed",
      tool: input.tool,
      operation: input.operation,
      arguments: input.arguments,
      rationale: input.rationale,
      requiredAuthority: input.requiredAuthority,
      destructive: input.destructive,
      idempotencyKey: input.idempotencyKey,
      proposedBy: input.proposedBy,
      createdAt: "2026-09-23T00:00:00.000Z",
      updatedAt: "2026-09-23T00:00:00.000Z",
    };
    this.rows.set(input.actionId, staged);
    return staged;
  }

  async get(input: { actionId: string; projectId: string }): Promise<ToolAction | null> {
    const row = this.rows.get(input.actionId);
    if (!row || row.projectId !== input.projectId) return null;
    return row;
  }
}

class RecordingClaims implements SingleUseConsumptionClaimStore {
  readonly calls: string[] = [];
  result: SingleUseExecutionClaimResult = { claimed: true, claimId: "pending" };

  async claim(_action: ToolAction, claimId: string): Promise<SingleUseExecutionClaimResult> {
    this.calls.push(claimId);
    if (!this.result.claimed) return this.result;
    return { claimed: true, claimId };
  }
}

class RecordingEligibility implements ExecutionEligibilityStore {
  calls = 0;
  result: { eligible: boolean; blockReason?: "not-approved" | "expired" } = { eligible: true };

  async verify(): Promise<{ eligible: boolean; blockReason?: "not-approved" | "expired" }> {
    this.calls += 1;
    return this.result;
  }
}

class RecordingReceipts extends InMemoryToolExecutionReceiptStore {
  saves = 0;

  override async save(key: string, receipt: ToolExecutionReceipt): Promise<void> {
    this.saves += 1;
    await super.save(key, receipt);
  }
}

class RecordingReconciliations implements ExternalReconciliationStore {
  envelope: ExternalReconciliationEnvelope | null = null;
  readonly markCalls: MarkExternalIndeterminateInput[] = [];
  readonly completeCalls: CompleteExternalAttemptInput[] = [];
  dropReads = false;

  async getByScope(scope: ExternalExecutionScope): Promise<ExternalReconciliationEnvelope | null> {
    if (this.dropReads) return null;
    const current = this.envelope;
    if (!current) return null;
    const record = current.reconciliation;
    if (
      record.projectId !== scope.projectId ||
      record.tool !== scope.tool ||
      record.operation !== scope.operation ||
      record.idempotencyKey !== scope.idempotencyKey ||
      record.effectFingerprint !== scope.effectFingerprint
    ) {
      return null;
    }
    return current;
  }

  async registerAttempt(
    input: RegisterExternalAttemptInput,
  ): Promise<ExternalReconciliationRecord> {
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
      providerCorrelationId: current?.providerCorrelationId ?? input.receipt.correlationId,
      receiptKey: input.receiptKey,
      receiptId: input.receipt.receiptId,
      state: current?.providerRequestId ? "pending" : "escalated",
      attemptCount: 0,
      nextAttemptAt: now,
      createdAt: current?.createdAt ?? now,
      updatedAt: now,
    };
    const receipt: ToolExecutionReceipt = {
      ...input.receipt,
      reconciliationId: record.reconciliationId,
      providerCorrelationId: record.providerCorrelationId,
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
    const receipt: ToolExecutionReceipt = {
      ...input.receipt,
      reconciliationId: current.reconciliationId,
      providerRequestId: current.providerRequestId,
      providerCorrelationId: current.providerCorrelationId,
    };
    this.envelope = {
      reconciliation: {
        ...current,
        state: "resolved",
        terminalStatus: "succeeded",
        receiptId: receipt.receiptId,
        updatedAt: Date.now(),
      },
      receipt,
    };
    return this.envelope;
  }

  async claimNext(): Promise<ExternalReconciliationClaim | null> {
    return null;
  }

  async resolveClaim(): Promise<ToolExecutionReceipt> {
    throw new Error("not used");
  }

  async releaseClaim(): Promise<ExternalReconciliationRecord> {
    throw new Error("not used");
  }

  async cleanup(): Promise<boolean> {
    return false;
  }
}

function externalDefinition(
  effects: string[],
  provider = "github-rest-v1",
): ToolExecutionDefinition {
  return {
    tool: "github",
    operation: "merge-pull-request",
    externalProvider: provider,
    schema: z.object({ head: z.string().min(1) }),
    async execute(_arguments, _signal, context) {
      effects.push("effect");
      await context.registerProviderAttempt({
        provider,
        providerRequestId: "merge-request-1",
        providerCorrelationId: context.correlationId,
      });
      return { merged: true };
    },
  };
}

function boundaryFor(input: {
  actions: MemoryActions;
  effects: string[];
  claims: RecordingClaims;
  eligibility: RecordingEligibility;
  receipts: RecordingReceipts;
  reconciliations: RecordingReconciliations;
  definition?: ToolExecutionDefinition;
}): GovernedExternalOperation {
  const execution = new ToolExecutionService(
    [input.definition ?? externalDefinition(input.effects)],
    input.receipts,
    input.reconciliations,
    input.claims,
    input.eligibility,
  );
  return new GovernedExternalOperation({
    actions: input.actions,
    execution,
    reconciliations: input.reconciliations,
  });
}

describe("governed external operation boundary", () => {
  it("refuses the fail-open in-memory claim and eligibility defaults", () => {
    const actions = new MemoryActions();
    const reconciliations = new RecordingReconciliations();
    const execution = new ToolExecutionService(
      [externalDefinition([])],
      new InMemoryToolExecutionReceiptStore(),
      reconciliations,
    );
    assert.throws(
      () =>
        new GovernedExternalOperation({
          actions,
          execution,
          reconciliations,
        }),
      /fail-open|ToolAction claim/,
    );
  });

  it("does not perform an external effect when the single-use claim is refused", async () => {
    const effects: string[] = [];
    const actions = new MemoryActions();
    actions.rows.set("action-1", approvedAction());
    const claims = new RecordingClaims();
    claims.result = { claimed: false, claimId: "", blockReason: "not-approved" };
    const boundary = boundaryFor({
      actions,
      effects,
      claims,
      eligibility: new RecordingEligibility(),
      receipts: new RecordingReceipts(),
      reconciliations: new RecordingReconciliations(),
    });

    const receipt = await boundary.execute({
      projectId: "project-1",
      actionId: "action-1",
      authority: "T3",
    });

    assert.equal(receipt.status, "blocked");
    assert.equal(receipt.errorCode, "not-authorized");
    assert.equal(receipt.receiptId.length > 0, true);
    assert.deepEqual(effects, []);
    assert.equal(claims.calls.length, 1);
  });

  it("does not perform an external effect when reusable eligibility is refused", async () => {
    const effects: string[] = [];
    const actions = new MemoryActions();
    actions.rows.set(
      "action-1",
      approvedAction({
        consumptionPolicy: "reusable",
        destructive: false,
        requiredAuthority: "T2",
      }),
    );
    const claims = new RecordingClaims();
    const eligibility = new RecordingEligibility();
    eligibility.result = { eligible: false, blockReason: "expired" };
    const boundary = boundaryFor({
      actions,
      effects,
      claims,
      eligibility,
      receipts: new RecordingReceipts(),
      reconciliations: new RecordingReconciliations(),
    });

    const receipt = await boundary.execute({
      projectId: "project-1",
      actionId: "action-1",
      authority: "T2",
    });

    assert.equal(receipt.status, "blocked");
    assert.equal(receipt.errorCode, "approval-expired");
    assert.deepEqual(effects, []);
    assert.equal(claims.calls.length, 0);
    assert.equal(eligibility.calls, 1);
  });

  it("writes a succeeded receipt only after a winning single-use claim", async () => {
    const order: string[] = [];
    const actions = new MemoryActions();
    actions.rows.set("action-1", approvedAction());
    const claims = new RecordingClaims();
    const original = claims.claim.bind(claims);
    claims.claim = async (action, claimId) => {
      order.push("claim");
      return original(action, claimId);
    };
    const definition = externalDefinition(order);
    const reconciliations = new RecordingReconciliations();
    const boundary = boundaryFor({
      actions,
      effects: order,
      claims,
      eligibility: new RecordingEligibility(),
      receipts: new RecordingReceipts(),
      reconciliations,
      definition,
    });

    const receipt = await boundary.execute({
      projectId: "project-1",
      actionId: "action-1",
      authority: "T3",
    });

    assert.equal(receipt.status, "succeeded");
    assert.equal(receipt.receiptId.length > 0, true);
    assert.equal(reconciliations.envelope?.receipt?.receiptId, receipt.receiptId);
    assert.deepEqual(order, ["claim", "effect"]);
    assert.equal(claims.calls[0], deriveToolExecutionIdempotencyKey("action-1", "live"));
  });

  it("requires a scheduled reconciliation before returning an indeterminate outcome", async () => {
    const effects: string[] = [];
    const actions = new MemoryActions();
    actions.rows.set("action-1", approvedAction());
    const reconciliations = new RecordingReconciliations();
    const definition: ToolExecutionDefinition = {
      ...externalDefinition(effects),
      async execute(_arguments, _signal, context) {
        effects.push("effect");
        await context.registerProviderAttempt({
          provider: "github-rest-v1",
          providerRequestId: "merge-request-1",
          providerCorrelationId: context.correlationId,
        });
        await new Promise<never>(() => undefined);
      },
    };
    const boundary = boundaryFor({
      actions,
      effects,
      claims: new RecordingClaims(),
      eligibility: new RecordingEligibility(),
      receipts: new RecordingReceipts(),
      reconciliations,
      definition,
    });

    const receipt = await boundary.execute({
      projectId: "project-1",
      actionId: "action-1",
      authority: "T3",
      timeoutMs: 20,
    });

    assert.equal(receipt.status, "indeterminate");
    assert.equal(reconciliations.markCalls.length, 1);
    assert.equal(
      receipt.reconciliationId,
      reconciliations.envelope?.reconciliation.reconciliationId,
    );
    assert.deepEqual(effects, ["effect"]);

    reconciliations.dropReads = true;
    const dropped = boundaryFor({
      actions,
      effects,
      claims: new RecordingClaims(),
      eligibility: new RecordingEligibility(),
      receipts: new RecordingReceipts(),
      reconciliations,
      definition,
    });
    await assert.rejects(
      dropped.execute({
        projectId: "project-1",
        actionId: "action-1",
        authority: "T3",
        timeoutMs: 20,
      }),
      GovernedExternalOperationRefused,
    );
  });

  it("rejects PolicyEngine allowlists before any claim or effect", async () => {
    const effects: string[] = [];
    const actions = new MemoryActions();
    actions.rows.set("action-1", approvedAction());
    const claims = new RecordingClaims();
    const boundary = boundaryFor({
      actions,
      effects,
      claims,
      eligibility: new RecordingEligibility(),
      receipts: new RecordingReceipts(),
      reconciliations: new RecordingReconciliations(),
    });

    await assert.rejects(
      boundary.execute({
        projectId: "project-1",
        actionId: "action-1",
        authority: "T3",
        authorityDecision: {
          kind: "policy-engine",
          allowedTools: ["github:merge-pull-request"],
          decision: "allow",
        },
      }),
      PolicyEngineNotAuthorityError,
    );
    await assert.rejects(
      boundary.execute({
        projectId: "project-1",
        actionId: "action-1",
        authority: "T3",
        authorityDecision: { allowlist: ["github:merge-pull-request"] },
      }),
      PolicyEngineNotAuthorityError,
    );
    assert.deepEqual(effects, []);
    assert.deepEqual(claims.calls, []);
  });

  it("refuses an unclassified consumption policy and an internal tool without an effect", async () => {
    const effects: string[] = [];
    const actions = new MemoryActions();
    actions.rows.set("action-1", approvedAction({ consumptionPolicy: undefined }));
    const claims = new RecordingClaims();
    const boundary = boundaryFor({
      actions,
      effects,
      claims,
      eligibility: new RecordingEligibility(),
      receipts: new RecordingReceipts(),
      reconciliations: new RecordingReconciliations(),
    });

    await assert.rejects(
      boundary.execute({ projectId: "project-1", actionId: "action-1", authority: "T3" }),
      /consumption policy/i,
    );

    actions.rows.set(
      "note-1",
      approvedAction({
        actionId: "note-1",
        tool: "notes",
        operation: "create",
        consumptionPolicy: "single-use",
        arguments: { body: "hello" },
      }),
    );
    await assert.rejects(
      boundary.execute({ projectId: "project-1", actionId: "note-1", authority: "T3" }),
      /external/i,
    );
    assert.deepEqual(effects, []);
    assert.deepEqual(claims.calls, []);
  });

  it("stages a proposal without approving or executing it", async () => {
    const effects: string[] = [];
    const actions = new MemoryActions();
    const boundary = boundaryFor({
      actions,
      effects,
      claims: new RecordingClaims(),
      eligibility: new RecordingEligibility(),
      receipts: new RecordingReceipts(),
      reconciliations: new RecordingReconciliations(),
    });

    const staged = await boundary.propose({
      actionId: "action-2",
      requestId: "request-2",
      projectId: "project-1",
      expectedRevision: 4,
      tool: "github",
      operation: "merge-pull-request",
      arguments: { head: "abc" },
      rationale: "Propose a merge.",
      requiredAuthority: "T3",
      destructive: true,
      idempotencyKey: "proposal-2",
      proposedBy: "agent",
    });

    assert.equal(staged.state, "proposed");
    assert.equal(actions.stageCalls, 1);
    assert.equal(actions.rows.get("action-2")?.state, "proposed");
    assert.deepEqual(effects, []);
  });

  it("returns null from the env factory unless Convex persistence is selected", () => {
    const previous = process.env.PERSISTENCE_PROVIDER;
    process.env.PERSISTENCE_PROVIDER = "json";
    try {
      assert.equal(createGovernedExternalOperationFromEnv(null, null), null);
    } finally {
      if (previous === undefined) delete process.env.PERSISTENCE_PROVIDER;
      else process.env.PERSISTENCE_PROVIDER = previous;
    }
  });
});
