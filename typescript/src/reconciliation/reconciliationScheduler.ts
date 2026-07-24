import type { ReconciliationRunResult, ReconciliationWorker } from "./reconciliationWorker.js";

type ReconciliationWorkerLike = Pick<ReconciliationWorker, "runOnce">;

type SchedulerOptions = {
  workerId: string;
  leaseMs: number;
  intervalMs: number;
  maxBatchSize: number;
  sleep?: (milliseconds: number, signal: AbortSignal) => Promise<void>;
};

export type ReconciliationCycleResult = {
  processed: number;
  skipped: boolean;
};

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
  }

  async runCycle(signal: AbortSignal): Promise<ReconciliationCycleResult> {
    if (this.cycleRunning) return { processed: 0, skipped: true };
    this.cycleRunning = true;
    try {
      let processed = 0;
      while (!signal.aborted && processed < this.maxBatchSize) {
        const result: ReconciliationRunResult = await this.worker.runOnce({
          workerId: this.workerId,
          leaseMs: this.leaseMs,
          signal,
        });
        if (result.status === "idle") break;
        processed += 1;
      }
      return { processed, skipped: false };
    } finally {
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
}
