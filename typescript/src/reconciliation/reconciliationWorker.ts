import { randomUUID } from "node:crypto";

import {
  providerReferenceFromRecord,
  type ExternalReconciliationStore,
  type ProviderReconciliationAdapter,
  type ProviderReconciliationResult,
} from "./externalReconciliation.js";

export type ReconciliationRunResult =
  | { status: "idle" }
  | {
      status: "resolved";
      reconciliationId: string;
      terminalStatus: "succeeded" | "failed";
    }
  | {
      status: "released";
      reconciliationId: string;
      nextAttemptAt: number;
    }
  | {
      status: "escalated";
      reconciliationId: string;
      reason: string;
    };

export class ProviderAdapterRegistry {
  private readonly adapters = new Map<string, ProviderReconciliationAdapter>();

  constructor(adapters: readonly ProviderReconciliationAdapter[]) {
    for (const adapter of adapters) {
      const provider = adapter.provider.trim();
      if (!provider) throw new Error("Provider reconciliation adapter name is required.");
      if (this.adapters.has(provider)) {
        throw new Error(`Duplicate provider reconciliation adapter: ${provider}`);
      }
      this.adapters.set(provider, adapter);
    }
  }

  get(provider: string): ProviderReconciliationAdapter | null {
    return this.adapters.get(provider) ?? null;
  }
}

type ReconciliationWorkerOptions = {
  store: ExternalReconciliationStore;
  adapters: readonly ProviderReconciliationAdapter[];
  now?: () => number;
  leaseToken?: () => string;
  maxAttempts?: number;
  baseRetryMs?: number;
  maxRetryMs?: number;
};

function positiveInteger(value: number, name: string): number {
  if (!Number.isSafeInteger(value) || value < 1) {
    throw new Error(`${name} must be a positive integer.`);
  }
  return value;
}

function cleanErrorCode(value: unknown): string {
  if (!(value instanceof Error)) return "provider-reconciliation-error";
  const message = value.message.trim();
  return message ? `provider-reconciliation-error:${message}` : "provider-reconciliation-error";
}

export class ReconciliationWorker {
  private readonly store: ExternalReconciliationStore;
  private readonly registry: ProviderAdapterRegistry;
  private readonly now: () => number;
  private readonly leaseToken: () => string;
  private readonly maxAttempts: number;
  private readonly baseRetryMs: number;
  private readonly maxRetryMs: number;

  constructor(options: ReconciliationWorkerOptions) {
    this.store = options.store;
    this.registry = new ProviderAdapterRegistry(options.adapters);
    this.now = options.now ?? Date.now;
    this.leaseToken = options.leaseToken ?? randomUUID;
    this.maxAttempts = positiveInteger(options.maxAttempts ?? 5, "Maximum reconciliation attempts");
    this.baseRetryMs = positiveInteger(options.baseRetryMs ?? 1_000, "Base reconciliation retry");
    this.maxRetryMs = positiveInteger(options.maxRetryMs ?? 60_000, "Maximum reconciliation retry");
    if (this.baseRetryMs > this.maxRetryMs) {
      throw new Error("Base reconciliation retry cannot exceed the maximum retry.");
    }
  }

  async runOnce(input: {
    workerId: string;
    leaseMs: number;
    signal: AbortSignal;
  }): Promise<ReconciliationRunResult> {
    if (input.signal.aborted) return { status: "idle" };

    const claimNow = this.now();
    const leaseToken = this.leaseToken();
    const claim = await this.store.claimNext({
      workerId: input.workerId,
      leaseToken,
      now: claimNow,
      leaseMs: positiveInteger(input.leaseMs, "Reconciliation lease duration"),
    });
    if (!claim) return { status: "idle" };

    const reconciliationId = claim.reconciliation.reconciliationId;
    const reference = providerReferenceFromRecord(claim.reconciliation);
    if (!reference) {
      return this.release(
        reconciliationId,
        input.workerId,
        leaseToken,
        claimNow,
        "provider-reference-missing",
        claimNow,
        1,
      );
    }

    const adapter = this.registry.get(reference.provider);
    if (!adapter) {
      const reason = `unknown-provider:${reference.provider}`;
      return this.release(
        reconciliationId,
        input.workerId,
        leaseToken,
        claimNow,
        reason,
        claimNow,
        1,
      );
    }

    let providerResult: ProviderReconciliationResult;
    try {
      providerResult = await adapter.reconcile(reference, input.signal);
    } catch (error: unknown) {
      const completionNow = this.now();
      const errorCode = input.signal.aborted
        ? "provider-reconciliation-aborted"
        : cleanErrorCode(error);
      const nextAttemptAt =
        completionNow + this.retryDelay(claim.reconciliation.attemptCount);
      return this.release(
        reconciliationId,
        input.workerId,
        leaseToken,
        completionNow,
        errorCode,
        nextAttemptAt,
        this.maxAttempts,
      );
    }

    const completionNow = this.now();
    if (providerResult.status === "succeeded" || providerResult.status === "failed") {
      await this.store.resolveClaim({
        reconciliationId,
        workerId: input.workerId,
        leaseToken,
        now: completionNow,
        result: providerResult,
      });
      return {
        status: "resolved",
        reconciliationId,
        terminalStatus: providerResult.status,
      };
    }

    const requestedDelay = providerResult.retryAfterMs;
    const retryDelay =
      requestedDelay === undefined
        ? this.retryDelay(claim.reconciliation.attemptCount)
        : Math.min(
            this.maxRetryMs,
            positiveInteger(requestedDelay, "Provider reconciliation retry delay"),
          );
    return this.release(
      reconciliationId,
      input.workerId,
      leaseToken,
      completionNow,
      providerResult.errorCode,
      completionNow + retryDelay,
      this.maxAttempts,
    );
  }

  private retryDelay(attemptCount: number): number {
    const exponent = Math.max(0, attemptCount - 1);
    return Math.min(this.maxRetryMs, this.baseRetryMs * 2 ** exponent);
  }

  private async release(
    reconciliationId: string,
    workerId: string,
    leaseToken: string,
    now: number,
    errorCode: string,
    nextAttemptAt: number,
    maxAttempts: number,
  ): Promise<ReconciliationRunResult> {
    const released = await this.store.releaseClaim({
      reconciliationId,
      workerId,
      leaseToken,
      now,
      errorCode,
      nextAttemptAt,
      maxAttempts,
    });
    if (released.state === "escalated") {
      return {
        status: "escalated",
        reconciliationId,
        reason: released.escalationReason ?? errorCode,
      };
    }
    return {
      status: "released",
      reconciliationId,
      nextAttemptAt: released.nextAttemptAt,
    };
  }
}
