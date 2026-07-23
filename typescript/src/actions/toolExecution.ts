import { createHash } from "node:crypto";

import type { z } from "zod";

import type { ToolAction } from "./toolActions.js";
import type { ToolAuthority } from "../runtime/totalityPolicy.js";

export type ToolExecutionStatus =
  | "dry-run"
  | "succeeded"
  | "failed"
  | "indeterminate"
  | "blocked";

export type ToolExecutionReceipt = {
  receiptId: string;
  actionId: string;
  projectId: string;
  idempotencyKey: string;
  actionFingerprint: string;
  tool: string;
  operation: string;
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

export type ToolExecutionDefinition = {
  tool: string;
  operation: string;
  schema: z.ZodType<Record<string, unknown>>;
  execute: (argumentsValue: Record<string, unknown>, signal: AbortSignal) => Promise<unknown>;
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

function digest(value: unknown): string {
  return createHash("sha256")
    .update(JSON.stringify(value) ?? "undefined", "utf8")
    .digest("hex");
}

export function fingerprintToolAction(action: ToolAction): string {
  return digest({
    actionId: action.actionId,
    projectId: action.projectId,
    baseRevision: action.baseRevision,
    tool: action.tool,
    operation: action.operation,
    arguments: action.arguments,
    requiredAuthority: action.requiredAuthority,
    destructive: action.destructive,
  });
}

function receiptId(action: ToolAction, idempotencyKey: string): string {
  return digest(`${action.actionId}:${idempotencyKey}`).slice(0, 32);
}

function receipt(
  action: ToolAction,
  idempotencyKey: string,
  status: ToolExecutionStatus,
  errorCode: ToolExecutionReceipt["errorCode"],
  startedAt: string,
): ToolExecutionReceipt {
  return {
    receiptId: receiptId(action, idempotencyKey),
    actionId: action.actionId,
    projectId: action.projectId,
    idempotencyKey,
    actionFingerprint: fingerprintToolAction(action),
    tool: action.tool,
    operation: action.operation,
    status,
    ...(errorCode === undefined ? {} : { errorCode }),
    startedAt,
    completedAt: new Date().toISOString(),
  };
}

export class ToolExecutionService {
  private readonly definitions = new Map<string, ToolExecutionDefinition>();
  private readonly inFlight = new Map<string, Promise<ToolExecutionReceipt>>();

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
  }): Promise<ToolExecutionReceipt> {
    const key = `${input.action.actionId}:${input.idempotencyKey}`;
    const expectedFingerprint = fingerprintToolAction(input.action);
    const existing = await this.receipts.get(key);
    if (existing) {
      if (existing.actionFingerprint !== expectedFingerprint) {
        return receipt(
          input.action,
          input.idempotencyKey,
          "blocked",
          "fingerprint-mismatch",
          new Date().toISOString(),
        );
      }
      return existing;
    }

    const active = this.inFlight.get(key);
    if (active) return active;

    const execution = this.executeOnce(input, key);
    this.inFlight.set(key, execution);
    try {
      return await execution;
    } finally {
      this.inFlight.delete(key);
    }
  }

  private async executeOnce(
    input: {
      action: ToolAction;
      authority: ToolAuthority;
      idempotencyKey: string;
      timeoutMs?: number;
      dryRun?: boolean;
    },
    key: string,
  ): Promise<ToolExecutionReceipt> {
    const startedAt = new Date().toISOString();
    const definition = this.definitions.get(`${input.action.tool}:${input.action.operation}`);

    if (
      input.action.state !== "approved" ||
      AUTHORITY_LEVEL[input.authority] < AUTHORITY_LEVEL[input.action.requiredAuthority]
    ) {
      return receipt(input.action, input.idempotencyKey, "blocked", "not-authorized", startedAt);
    }
    if (!definition) {
      return receipt(input.action, input.idempotencyKey, "blocked", "not-allowlisted", startedAt);
    }

    const parsed = definition.schema.safeParse(input.action.arguments);
    if (!parsed.success) {
      return receipt(input.action, input.idempotencyKey, "blocked", "invalid-arguments", startedAt);
    }
    if (input.dryRun) {
      return receipt(input.action, input.idempotencyKey, "dry-run", undefined, startedAt);
    }

    const timeoutMs = input.timeoutMs ?? 5_000;
    if (!Number.isInteger(timeoutMs) || timeoutMs < 1 || timeoutMs > MAX_TIMEOUT_MS) {
      throw new Error(`timeoutMs must be an integer between 1 and ${MAX_TIMEOUT_MS}.`);
    }

    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), timeoutMs);
    try {
      const output = await Promise.race([
        definition.execute(parsed.data, controller.signal),
        new Promise<never>((_, reject) =>
          controller.signal.addEventListener("abort", () => reject(new Error("timeout")), {
            once: true,
          }),
        ),
      ]);
      const result: ToolExecutionReceipt = {
        ...receipt(input.action, input.idempotencyKey, "succeeded", undefined, startedAt),
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
      );
      await this.receipts.save(key, result);
      return result;
    } finally {
      clearTimeout(timeout);
    }
  }
}
