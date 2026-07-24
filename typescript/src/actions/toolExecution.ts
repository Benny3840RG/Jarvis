import { createHash } from "node:crypto";

import type { z } from "zod";

import type {
  ExternalExecutionScope,
  ExternalReconciliationStore,
  ProviderAttemptReference,
} from "../reconciliation/externalReconciliation.js";
import {
  externalExecutionScopeKey,
  providerReferenceFromRecord,
} from "../reconciliation/externalReconciliation.js";
import type { ToolAuthority } from "../runtime/totalityPolicy.js";
import { canonicalJson } from "./canonicalJson.js";
import type { ToolAction } from "./toolActions.js";

export type ToolExecutionStatus = "dry-run" | "succeeded" | "failed" | "indeterminate" | "blocked";

export type ToolExecutionErrorCode =
  | "not-authorized"
  | "not-allowlisted"
  | "invalid-arguments"
  | "indeterminate"
  | "failed"
  | "fingerprint-mismatch"
  | "provider-failed"
  | "provider-reference-missing"
  | "retry-blocked-pending-reconciliation"
  | "reconciliation-escalated"
  | "reconciliation-unavailable";

export type ToolExecutionReceipt = {
  receiptId: string;
  actionId: string;
  requestId: string;
  projectId: string;
  idempotencyKey: string;
  actionFingerprint: string;
  effectFingerprint?: string;
  tool: string;
  operation: string;
  actor: ToolAction["proposedBy"];
  approvalId?: string;
  policyVersion: string;
  correlationId: string;
  source: string;
  provider?: string;
  providerRequestId?: string;
  providerCorrelationId?: string;
  reconciliationId?: string;
  status: ToolExecutionStatus;
  outputDigest?: string;
  errorCode?: ToolExecutionErrorCode;
  providerErrorCode?: string;
  startedAt: string;
  completedAt: string;
};

export type ToolExecutionContext = {
  action: ToolAction;
  idempotencyKey: string;
  actionFingerprint: string;
  effectFingerprint: string;
  correlationId: string;
  source: string;
  approvalId?: string;
  policyVersion: string;
  registerProviderAttempt(reference: ProviderAttemptReference): Promise<void>;
};

export type ToolExecutionDefinition = {
  tool: string;
  operation: string;
  schema: z.ZodType<Record<string, unknown>>;
  externalProvider?: string;
  execute: (
    argumentsValue: Record<string, unknown>,
    signal: AbortSignal,
    context: ToolExecutionContext,
  ) => Promise<unknown>;
};

export interface ToolExecutionReceiptStore {
  get(key: string): Promise<ToolExecutionReceipt | null>;
  save(key: string, receipt: ToolExecutionReceipt): Promise<void>;
}

export class InMemoryToolExecutionReceiptStore implements ToolExecutionReceiptStore {
  private readonly receipts = new Map<string, ToolExecutionReceipt>();

  async get(key: string): Promise<ToolExecutionReceipt | null> {
    return this.receipts.get(key) ?? null;
  }

  async save(key: string, receipt: ToolExecutionReceipt): Promise<void> {
    this.receipts.set(key, receipt);
  }
}

const AUTHORITY_LEVEL: Record<ToolAuthority, number> = { T0: 0, T1: 1, T2: 2, T3: 3 };
const MAX_TIMEOUT_MS = 30_000;
const ACTION_FINGERPRINT_VERSION = "jarvis-action-fingerprint:v1";
const EFFECT_FINGERPRINT_VERSION = "jarvis-effect-fingerprint:v1";

function digest(value: unknown): string {
  return createHash("sha256").update(canonicalJson(value), "utf8").digest("hex");
}

function isEffectFingerprintConflict(error: unknown): boolean {
  if (!(error instanceof Error)) return false;
  return (
    error.message.includes("another effect fingerprint") ||
    error.message.includes("effect fingerprint collision")
  );
}
export function fingerprintToolAction(action: ToolAction): string {
  const hash = digest({
    actionId: action.actionId,
    projectId: action.projectId,
    baseRevision: action.baseRevision,
    tool: action.tool,
    operation: action.operation,
    arguments: action.arguments,
    requiredAuthority: action.requiredAuthority,
    destructive: action.destructive,
  });
  return `${ACTION_FINGERPRINT_VERSION}:${hash}`;
}

export function fingerprintToolEffect(action: ToolAction): string {
  const hash = digest({
    projectId: action.projectId,
    tool: action.tool,
    operation: action.operation,
    arguments: action.arguments,
    destructive: action.destructive,
  });
  return `${EFFECT_FINGERPRINT_VERSION}:${hash}`;
}

function internalExecutionKey(action: ToolAction, idempotencyKey: string): string {
  return `${action.projectId}:${action.actionId}:${idempotencyKey}`;
}

function externalScope(
  action: ToolAction,
  idempotencyKey: string,
  effectFingerprint: string,
): ExternalExecutionScope {
  return {
    projectId: action.projectId,
    tool: action.tool,
    operation: action.operation,
    idempotencyKey,
    effectFingerprint,
  };
}

function externalExecutionKey(scope: ExternalExecutionScope): string {
  return `external:${externalExecutionScopeKey(scope)}`;
}

function reconciliationId(scope: ExternalExecutionScope): string {
  return `reconciliation-${digest(scope).slice(0, 32)}`;
}

function receiptId(
  action: ToolAction,
  idempotencyKey: string,
  status: ToolExecutionStatus,
): string {
  return digest({
    projectId: action.projectId,
    actionId: action.actionId,
    idempotencyKey,
    status,
  }).slice(0, 32);
}

type ExecutionMetadata = {
  approvalId?: string;
  policyVersion?: string;
  correlationId?: string;
  source?: string;
};

type ReceiptMetadata = ExecutionMetadata & {
  actionFingerprint?: string;
  effectFingerprint?: string;
  provider?: string;
  providerRequestId?: string;
  providerCorrelationId?: string;
  reconciliationId?: string;
  providerErrorCode?: string;
};

function receipt(
  action: ToolAction,
  idempotencyKey: string,
  status: ToolExecutionStatus,
  errorCode: ToolExecutionReceipt["errorCode"],
  startedAt: string,
  metadata: ReceiptMetadata,
): ToolExecutionReceipt {
  return {
    receiptId: receiptId(action, idempotencyKey, status),
    actionId: action.actionId,
    requestId: action.requestId,
    projectId: action.projectId,
    idempotencyKey,
    actionFingerprint: metadata.actionFingerprint ?? fingerprintToolAction(action),
    ...(metadata.effectFingerprint === undefined
      ? {}
      : { effectFingerprint: metadata.effectFingerprint }),
    tool: action.tool,
    operation: action.operation,
    actor: action.proposedBy,
    ...(metadata.approvalId === undefined ? {} : { approvalId: metadata.approvalId }),
    policyVersion: metadata.policyVersion ?? "totality-policy:v1",
    correlationId: metadata.correlationId ?? action.requestId,
    source: metadata.source ?? "tool-execution-service",
    ...(metadata.provider === undefined ? {} : { provider: metadata.provider }),
    ...(metadata.providerRequestId === undefined
      ? {}
      : { providerRequestId: metadata.providerRequestId }),
    ...(metadata.providerCorrelationId === undefined
      ? {}
      : { providerCorrelationId: metadata.providerCorrelationId }),
    ...(metadata.reconciliationId === undefined
      ? {}
      : { reconciliationId: metadata.reconciliationId }),
    status,
    ...(errorCode === undefined ? {} : { errorCode }),
    ...(metadata.providerErrorCode === undefined
      ? {}
      : { providerErrorCode: metadata.providerErrorCode }),
    startedAt,
    completedAt: new Date().toISOString(),
  };
}

type ExecuteInput = {
  action: ToolAction;
  authority: ToolAuthority;
  idempotencyKey: string;
  timeoutMs?: number;
  dryRun?: boolean;
  approvalId?: string;
  policyVersion?: string;
  correlationId?: string;
  source?: string;
};

export class ToolExecutionService {
  private readonly definitions = new Map<string, ToolExecutionDefinition>();
  private readonly inFlight = new Map<
    string,
    { fingerprint: string; promise: Promise<ToolExecutionReceipt> }
  >();

  constructor(
    definitions: readonly ToolExecutionDefinition[],
    private readonly receipts: ToolExecutionReceiptStore = new InMemoryToolExecutionReceiptStore(),
    private readonly reconciliations?: ExternalReconciliationStore,
  ) {
    for (const definition of definitions) {
      const key = `${definition.tool}:${definition.operation}`;
      if (this.definitions.has(key)) throw new Error(`Duplicate tool definition: ${key}`);
      if (definition.externalProvider !== undefined && reconciliations === undefined) {
        throw new Error(`External tool definition ${key} requires an ExternalReconciliationStore.`);
      }
      this.definitions.set(key, definition);
    }
  }

  async execute(input: ExecuteInput): Promise<ToolExecutionReceipt> {
    const definition = this.definitions.get(`${input.action.tool}:${input.action.operation}`);
    const effectFingerprint = fingerprintToolEffect(input.action);
    const external = definition?.externalProvider !== undefined;
    const scope = external
      ? externalScope(input.action, input.idempotencyKey, effectFingerprint)
      : undefined;
    const key = scope
      ? externalExecutionKey(scope)
      : internalExecutionKey(input.action, input.idempotencyKey);
    const expectedFingerprint = external ? effectFingerprint : fingerprintToolAction(input.action);

    if (scope && definition?.externalProvider) {
      const replay = await this.replayExternal(input, definition.externalProvider, scope, key);
      if (replay) return replay;
    }

    const existing = await this.receipts.get(key);
    if (existing) {
      const existingFingerprint = external
        ? existing.effectFingerprint
        : existing.actionFingerprint;
      if (existingFingerprint !== expectedFingerprint) {
        return this.persistDecision(
          key,
          receipt(
            input.action,
            input.idempotencyKey,
            "blocked",
            "fingerprint-mismatch",
            new Date().toISOString(),
            {
              ...input,
              ...(external ? { effectFingerprint } : {}),
            },
          ),
        );
      }
      return existing;
    }

    const active = this.inFlight.get(key);
    if (active) {
      if (active.fingerprint !== expectedFingerprint) {
        return this.persistDecision(
          key,
          receipt(
            input.action,
            input.idempotencyKey,
            "blocked",
            "fingerprint-mismatch",
            new Date().toISOString(),
            {
              ...input,
              ...(external ? { effectFingerprint } : {}),
            },
          ),
        );
      }
      return active.promise;
    }

    const execution = this.executeOnce(input, definition, key, effectFingerprint, scope);
    this.inFlight.set(key, { fingerprint: expectedFingerprint, promise: execution });
    try {
      return await execution;
    } finally {
      this.inFlight.delete(key);
    }
  }

  private async replayExternal(
    input: ExecuteInput,
    provider: string,
    scope: ExternalExecutionScope,
    key: string,
  ): Promise<ToolExecutionReceipt | null> {
    if (!this.reconciliations) throw new Error("External reconciliation store is unavailable.");
    let envelope;
    try {
      envelope = await this.reconciliations.getByScope(scope);
    } catch (error: unknown) {
      const errorCode = isEffectFingerprintConflict(error)
        ? "fingerprint-mismatch"
        : "reconciliation-unavailable";
      return this.persistDecision(
        key,
        receipt(
          input.action,
          input.idempotencyKey,
          "blocked",
          errorCode,
          new Date().toISOString(),
          { ...input, effectFingerprint: scope.effectFingerprint, provider },
        ),
      );
    }
    if (!envelope) return null;
    if (envelope.receipt) return envelope.receipt;

    const startedAt = new Date().toISOString();
    const providerReference = providerReferenceFromRecord(envelope.reconciliation);
    const unresolved = receipt(
      input.action,
      input.idempotencyKey,
      "indeterminate",
      envelope.reconciliation.state === "escalated"
        ? "reconciliation-escalated"
        : "retry-blocked-pending-reconciliation",
      startedAt,
      {
        ...input,
        actionFingerprint: envelope.reconciliation.actionFingerprint,
        effectFingerprint: envelope.reconciliation.effectFingerprint,
        provider,
        ...(providerReference === null
          ? {}
          : {
              providerRequestId: providerReference.providerRequestId,
              providerCorrelationId: providerReference.providerCorrelationId,
            }),
        reconciliationId: envelope.reconciliation.reconciliationId,
      },
    );
    const bound = await this.reconciliations.markIndeterminate({
      ...scope,
      reconciliationId: envelope.reconciliation.reconciliationId,
      executionKey: envelope.reconciliation.executionKey,
      actionId: envelope.reconciliation.actionId,
      requestId: envelope.reconciliation.requestId,
      actionFingerprint: envelope.reconciliation.actionFingerprint,
      expectedProvider: provider,
      receiptKey: key,
      receipt: unresolved,
      ...(providerReference === null
        ? { missingReferenceReason: "reconciliation-record-has-no-provider-request" }
        : {}),
    });
    if (!bound.receipt)
      throw new Error("External replay did not produce an authoritative receipt.");
    return bound.receipt;
  }

  private async persistDecision(
    key: string,
    decision: ToolExecutionReceipt,
  ): Promise<ToolExecutionReceipt> {
    const decisionKey = `${key}:decision:${decision.receiptId}:${decision.completedAt}`;
    await this.receipts.save(decisionKey, decision);
    return decision;
  }

  private async executeOnce(
    input: ExecuteInput,
    definition: ToolExecutionDefinition | undefined,
    key: string,
    effectFingerprint: string,
    scope: ExternalExecutionScope | undefined,
  ): Promise<ToolExecutionReceipt> {
    const startedAt = new Date().toISOString();

    if (
      input.action.state !== "approved" ||
      AUTHORITY_LEVEL[input.authority] < AUTHORITY_LEVEL[input.action.requiredAuthority]
    ) {
      return this.persistDecision(
        key,
        receipt(input.action, input.idempotencyKey, "blocked", "not-authorized", startedAt, input),
      );
    }
    if (!definition) {
      return this.persistDecision(
        key,
        receipt(input.action, input.idempotencyKey, "blocked", "not-allowlisted", startedAt, input),
      );
    }

    const parsed = definition.schema.safeParse(input.action.arguments);
    if (!parsed.success) {
      return this.persistDecision(
        key,
        receipt(
          input.action,
          input.idempotencyKey,
          "blocked",
          "invalid-arguments",
          startedAt,
          input,
        ),
      );
    }
    if (input.dryRun) {
      return this.persistDecision(
        key,
        receipt(input.action, input.idempotencyKey, "dry-run", undefined, startedAt, input),
      );
    }

    const timeoutMs = input.timeoutMs ?? 5_000;
    if (!Number.isInteger(timeoutMs) || timeoutMs < 1 || timeoutMs > MAX_TIMEOUT_MS) {
      throw new Error(`timeoutMs must be an integer between 1 and ${MAX_TIMEOUT_MS}.`);
    }

    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), timeoutMs);
    const actionFingerprint = fingerprintToolAction(input.action);
    const externalProvider = definition.externalProvider;
    const externalReconciliationId = scope ? reconciliationId(scope) : undefined;
    let registeredReference: ProviderAttemptReference | undefined;
    const context: ToolExecutionContext = {
      action: input.action,
      idempotencyKey: input.idempotencyKey,
      actionFingerprint,
      effectFingerprint,
      correlationId: input.correlationId ?? input.action.requestId,
      source: input.source ?? "tool-execution-service",
      ...(input.approvalId === undefined ? {} : { approvalId: input.approvalId }),
      policyVersion: input.policyVersion ?? "totality-policy:v1",
      registerProviderAttempt: async (reference) => {
        if (!scope || !externalProvider || !externalReconciliationId || !this.reconciliations) {
          throw new Error("Internal tool definitions cannot register external provider attempts.");
        }
        if (reference.provider !== externalProvider) {
          throw new Error("Registered provider does not match the external tool definition.");
        }
        if (
          registeredReference &&
          (registeredReference.providerRequestId !== reference.providerRequestId ||
            registeredReference.providerCorrelationId !== reference.providerCorrelationId)
        ) {
          throw new Error("External tool attempted to register conflicting provider references.");
        }
        const record = await this.reconciliations.registerAttempt({
          ...scope,
          reconciliationId: externalReconciliationId,
          executionKey: key,
          actionId: input.action.actionId,
          requestId: input.action.requestId,
          actionFingerprint,
          reference,
        });
        registeredReference = providerReferenceFromRecord(record) ?? reference;
      },
    };

    try {
      const output = await Promise.race([
        definition.execute(parsed.data, controller.signal, context),
        new Promise<never>((_, reject) =>
          controller.signal.addEventListener("abort", () => reject(new Error("timeout")), {
            once: true,
          }),
        ),
      ]);

      if (scope && externalProvider && externalReconciliationId && this.reconciliations) {
        if (!registeredReference) {
          const unresolved = receipt(
            input.action,
            input.idempotencyKey,
            "indeterminate",
            "provider-reference-missing",
            startedAt,
            {
              ...input,
              actionFingerprint,
              effectFingerprint,
              provider: externalProvider,
              reconciliationId: externalReconciliationId,
            },
          );
          const envelope = await this.reconciliations.markIndeterminate({
            ...scope,
            reconciliationId: externalReconciliationId,
            executionKey: key,
            actionId: input.action.actionId,
            requestId: input.action.requestId,
            actionFingerprint,
            expectedProvider: externalProvider,
            receiptKey: key,
            receipt: unresolved,
            missingReferenceReason: "external-success-without-provider-reference",
          });
          if (!envelope.receipt) {
            throw new Error("Missing-reference escalation did not persist a receipt.");
          }
          return envelope.receipt;
        }

        const succeeded: ToolExecutionReceipt = {
          ...receipt(input.action, input.idempotencyKey, "succeeded", undefined, startedAt, {
            ...input,
            actionFingerprint,
            effectFingerprint,
            provider: externalProvider,
            providerRequestId: registeredReference.providerRequestId,
            providerCorrelationId: registeredReference.providerCorrelationId,
            reconciliationId: externalReconciliationId,
          }),
          outputDigest: digest(output),
        };
        const envelope = await this.reconciliations.completeAttempt({
          ...scope,
          reconciliationId: externalReconciliationId,
          executionKey: key,
          actionId: input.action.actionId,
          requestId: input.action.requestId,
          actionFingerprint,
          expectedProvider: externalProvider,
          receiptKey: key,
          receipt: succeeded,
        });
        if (!envelope.receipt) throw new Error("External completion did not persist a receipt.");
        return envelope.receipt;
      }

      const result: ToolExecutionReceipt = {
        ...receipt(input.action, input.idempotencyKey, "succeeded", undefined, startedAt, input),
        outputDigest: digest(output),
      };
      await this.receipts.save(key, result);
      return result;
    } catch (error: unknown) {
      const timedOut = error instanceof Error && error.message === "timeout";
      if (scope && externalProvider && externalReconciliationId && this.reconciliations) {
        if (timedOut || registeredReference) {
          const unresolved = receipt(
            input.action,
            input.idempotencyKey,
            "indeterminate",
            registeredReference ? "indeterminate" : "provider-reference-missing",
            startedAt,
            {
              ...input,
              actionFingerprint,
              effectFingerprint,
              provider: externalProvider,
              ...(registeredReference === undefined
                ? {}
                : {
                    providerRequestId: registeredReference.providerRequestId,
                    providerCorrelationId: registeredReference.providerCorrelationId,
                  }),
              reconciliationId: externalReconciliationId,
            },
          );
          const envelope = await this.reconciliations.markIndeterminate({
            ...scope,
            reconciliationId: externalReconciliationId,
            executionKey: key,
            actionId: input.action.actionId,
            requestId: input.action.requestId,
            actionFingerprint,
            expectedProvider: externalProvider,
            receiptKey: key,
            receipt: unresolved,
            ...(registeredReference === undefined
              ? { missingReferenceReason: "external-timeout-before-provider-reference" }
              : {}),
          });
          if (!envelope.receipt) throw new Error("External uncertainty did not persist a receipt.");
          return envelope.receipt;
        }
      }

      const result = receipt(
        input.action,
        input.idempotencyKey,
        timedOut ? "indeterminate" : "failed",
        timedOut ? "indeterminate" : "failed",
        startedAt,
        input,
      );
      await this.receipts.save(key, result);
      return result;
    } finally {
      clearTimeout(timeout);
    }
  }
}
