import type { SentryRuntime } from "../observability/sentry.js";
import type { ReconciliationRunResult, ReconciliationWorker } from "./reconciliationWorker.js";

type ReconciliationWorkerLike = Pick<ReconciliationWorker, "runOnce">;

type SchedulerOptions = {
  workerId: string;
  leaseMs: number;
  intervalMs: number;
  maxBatchSize: number;
  sleep?: (milliseconds: number, signal: AbortSignal) => Promise<void>;
  observeCycle?: (observation: ReconciliationCycleObservation) => void;
  observability?: SentryRuntime;
};

export type ReconciliationCycleResult = {
  processed: number;
  skipped: boolean;
};

export type ReconciliationCycleObservation =
  | { type: "started" }
  | { type: "completed"; processed: number }
  | { type: "skipped" }
  | { type: "failed" };

function positiveInteger(value: number, name: string): number {
  if (!Number.isSafeInteger(value) || value < 1) {
    throw new Error(`${name} must be a positive integer.`);
  }
  return value;
}

async function abortableSleep(milliseconds: number, signal: AbortSignal): Promise<void> {
  if (signal.aborted) return;
  await new Promise<void>((resolve) => {
    const finish = () => {
      clearTimeout(timeout);
      signal.removeEventListener("abort", finish);
      resolve();
    };
    const timeout = setTimeout(finish, milliseconds);
    signal.addEventListener("abort", finish, { once: true });
  });
}

export class ReconciliationScheduler {
  private readonly workerId: string;
  private readonly leaseMs: number;
  private readonly intervalMs: number;
  private readonly maxBatchSize: number;
  private readonly sleep: (milliseconds: number, signal: AbortSignal) => Promise<void>;
  private readonly observeCycle:
    ((observation: ReconciliationCycleObservation) => void) | undefined;
  private readonly observability: SentryRuntime | undefined;
  private cycleRunning = false;

  constructor(
    private readonly worker: ReconciliationWorkerLike,
    options: SchedulerOptions,
  ) {
    this.workerId = options.workerId.trim();
    if (!this.workerId) throw new Error("Reconciliation scheduler worker ID is required.");
    this.leaseMs = positiveInteger(options.leaseMs, "Reconciliation scheduler lease duration");
    this.intervalMs = positiveInteger(options.intervalMs, "Reconciliation scheduler interval");
    this.maxBatchSize = positiveInteger(
      options.maxBatchSize,
      "Reconciliation scheduler batch size",
    );
    this.sleep = options.sleep ?? abortableSleep;
    this.observeCycle = options.observeCycle;
    this.observability = options.observability;
  }

  async runCycle(signal: AbortSignal): Promise<ReconciliationCycleResult> {
    const startedAt = performance.now();
    if (this.cycleRunning) {
      this.notify({ type: "skipped" });
      await this.observeMeasurement({
        durationMs: 0,
        success: true,
        measurements: { processed: 0, failure_count: 0 },
        tags: { outcome: "skipped" },
      });
      return { processed: 0, skipped: true };
    }

    this.cycleRunning = true;
    this.notify({ type: "started" });
    let processed = 0;
    let failureCount = 0;
    let success = false;
    try {
      while (!signal.aborted && processed < this.maxBatchSize) {
        const result: ReconciliationRunResult = await this.worker.runOnce({
          workerId: this.workerId,
          leaseMs: this.leaseMs,
          signal,
        });
        if (result.status === "idle") break;
        processed += 1;
        if (result.status === "released" || result.status === "escalated") failureCount += 1;
      }
      success = failureCount === 0;
      this.notify({ type: "completed", processed });
      return { processed, skipped: false };
    } catch (error: unknown) {
      this.notify({ type: "failed" });
      await this.observeError(error);
      throw error;
    } finally {
      await this.observeMeasurement({
        durationMs: performance.now() - startedAt,
        success,
        measurements: { processed, failure_count: failureCount },
        tags: { outcome: success ? "success" : "failure" },
      });
      this.cycleRunning = false;
    }
  }

  async run(signal: AbortSignal): Promise<void> {
    while (!signal.aborted) {
      await this.runCycle(signal);
      if (signal.aborted) break;
      await this.sleep(this.intervalMs, signal);
    }
  }

  private async observeMeasurement(input: {
    durationMs: number;
    success: boolean;
    measurements: Record<string, number>;
    tags: Record<string, string>;
  }): Promise<void> {
    try {
      await this.observability?.recordMeasurement({
        operation: "reconciliation.cycle",
        ...input,
      });
    } catch {
      // Observability is best-effort and must not alter reconciliation outcomes.
    }
  }

  private async observeError(error: unknown): Promise<void> {
    try {
      await this.observability?.captureError(error, {
        operation: "reconciliation.cycle",
        route: "worker",
        tags: { worker: this.workerId },
      });
    } catch {
      // Observability is best-effort and must not alter reconciliation outcomes.
    }
  }

  private notify(observation: ReconciliationCycleObservation): void {
    try {
      this.observeCycle?.(observation);
    } catch {
      // Observation is best-effort and must not alter reconciliation outcomes.
    }
  }
}
