import { createHash } from "node:crypto";

import type { z } from "zod";

import { canonicalJson } from "./canonicalJson.js";
import type { ToolAction } from "./toolActions.js";
import type { ToolAuthority } from "../runtime/totalityPolicy.js";

export type ToolExecutionStatus = "dry-run" | "succeeded" | "failed" | "indeterminate" | "blocked";

export type ToolExecutionReceipt = {
  receiptId: string;
  actionId: string;
  requestId: string;
  projectId: string;
  idempotencyKey: string;
  actionFingerprint: string;
  tool: string;
  operation: string;
  actor: ToolAction["proposedBy"];
  approvalId?: string;
  policyVersion: string;
  correlationId: string;
  source: string;
  status: ToolExecutionStatus;
  outputDigest?: string;
  errorCode?:
    | "not-authorized"
    | "not-allowlisted"
    | "invalid-arguments"
    | "indeterminate"
    | "failed"
    | "fingerprint-mismatch";
  startedAt: string;
  completedAt: string;
};

export type ToolExecutionContext = {
  action: ToolAction;
  idempotencyKey: string;
  actionFingerprint: string;
  correlationId: string;
  source: string;
  approvalId?: string;
  policyVersion: string;
};

export type ToolExecutionDefinition = {
  tool: string;
  operation: string;
  schema: z.ZodType<Record<string, unknown>>;
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
const FINGERPRINT_VERSION = "jarvis-action-fingerprint:v1";

function digest(value: unknown): string {
  return createHash("sha256").update(canonicalJson(value), "utf8").digest("hex");
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
  return `${FINGERPRINT_VERSION}:${hash}`;
}

function executionKey(action: ToolAction, idempotencyKey: string): string {
  return `${action.projectId}:${action.actionId}:${idempotencyKey}`;
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

function receipt(
  action: ToolAction,
  idempotencyKey: string,
  status: ToolExecutionStatus,
  errorCode: ToolExecutionReceipt["errorCode"],
  startedAt: string,
  metadata: ExecutionMetadata,
): ToolExecutionReceipt {
  return {
    receiptId: receiptId(action, idempotencyKey, status),
    actionId: action.actionId,
    requestId: action.requestId,
    projectId: action.projectId,
    idempotencyKey,
    actionFingerprint: fingerprintToolAction(action),
    tool: action.tool,
    operation: action.operation,
    actor: action.proposedBy,
    ...(metadata.approvalId === undefined ? {} : { approvalId: metadata.approvalId }),
    policyVersion: metadata.policyVersion ?? "totality-policy:v1",
    correlationId: metadata.correlationId ?? action.requestId,
    source: metadata.source ?? "tool-execution-service",
    status,
    ...(errorCode === undefined ? {} : { errorCode }),
    startedAt,
    completedAt: new Date().toISOString(),
  };
}

export class ToolExecutionService {
  private readonly definitions = new Map<string, ToolExecutionDefinition>();
  private readonly inFlight = new Map<
    string,
    { fingerprint: string; promise: Promise<ToolExecutionReceipt> }
  >();

  constructor(
    definitions: readonly ToolExecutionDefinition[],
    private readonly receipts: ToolExecutionReceiptStore = new InMemoryToolExecutionReceiptStore(),
  ) {
    for (const definition of definitions) {
      const key = `${definition.tool}:${definition.operation}`;
      if (this.definitions.has(key)) throw new Error(`Duplicate tool definition: ${key}`);
      this.definitions.set(key, definition);
    }
  }

  async execute(input: {
    action: ToolAction;
    authority: ToolAuthority;
    idempotencyKey: string;
    timeoutMs?: number;
    dryRun?: boolean;
    approvalId?: string;
    policyVersion?: string;
    correlationId?: string;
    source?: string;
  }): Promise<ToolExecutionReceipt> {
    const key = executionKey(input.action, input.idempotencyKey);
    const expectedFingerprint = fingerprintToolAction(input.action);
    const existing = await this.receipts.get(key);
    if (existing) {
      if (existing.actionFingerprint !== expectedFingerprint) {
        return this.persistDecision(
          key,
          receipt(
            input.action,
            input.idempotencyKey,
            "blocked",
            "fingerprint-mismatch",
            new Date().toISOString(),
            input,
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
            input,
          ),
        );
      }
      return active.promise;
    }

    const execution = this.executeOnce(input, key);
    this.inFlight.set(key, { fingerprint: expectedFingerprint, promise: execution });
    try {
      return await execution;
    } finally {
      this.inFlight.delete(key);
    }
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
    input: {
      action: ToolAction;
      authority: ToolAuthority;
      idempotencyKey: string;
      timeoutMs?: number;
      dryRun?: boolean;
      approvalId?: string;
      policyVersion?: string;
      correlationId?: string;
      source?: string;
    },
    key: string,
  ): Promise<ToolExecutionReceipt> {
    const startedAt = new Date().toISOString();
    const definition = this.definitions.get(`${input.action.tool}:${input.action.operation}`);

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
    const context: ToolExecutionContext = {
      action: input.action,
      idempotencyKey: input.idempotencyKey,
      actionFingerprint,
      correlationId: input.correlationId ?? input.action.requestId,
      source: input.source ?? "tool-execution-service",
      ...(input.approvalId === undefined ? {} : { approvalId: input.approvalId }),
      policyVersion: input.policyVersion ?? "totality-policy:v1",
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
      const result: ToolExecutionReceipt = {
        ...receipt(input.action, input.idempotencyKey, "succeeded", undefined, startedAt, input),
        outputDigest: digest(output),
      };
      await this.receipts.save(key, result);
      return result;
    } catch (error: unknown) {
      const timedOut = error instanceof Error && error.message === "timeout";
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
