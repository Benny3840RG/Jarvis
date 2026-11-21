/**
 * Running governed tool executions, tracked so `nolan sec halt` (#839) can
 * cancel them and prove when they have stopped.
 *
 * An entry is registered when an execution attempt starts and stays counted
 * until its effect has settled. A provider that ignores its abort signal and
 * keeps acting therefore keeps the count above zero, so a halt never reports
 * "verified stopped" while an effect may still be running.
 *
 * This module is imported (through toolExecution.ts) by Convex default-runtime
 * modules, so it must not import Node built-ins.
 */
export class RunningExecution {
  readonly halt = new AbortController();
  private effect: Promise<unknown> | undefined;
  private effectSettled = false;

  /** The halt abort signal; aborted once a halt cancels this execution. */
  get signal(): AbortSignal {
    return this.halt.signal;
  }

  trackEffect(effect: Promise<unknown>): void {
    this.effect = effect;
    const settle = () => {
      this.effectSettled = true;
    };
    effect.then(settle, settle);
  }

  /** Resolves once nothing this execution started can still be running. */
  settled(): Promise<void> {
    if (this.effect === undefined || this.effectSettled) return Promise.resolve();
    return this.effect.then(
      () => undefined,
      () => undefined,
    );
  }
}

export class RunningExecutionRegistry {
  private readonly entries = new Set<RunningExecution>();

  begin(): RunningExecution {
    const entry = new RunningExecution();
    this.entries.add(entry);
    return entry;
  }

  /** Called when the attempt returns; the entry leaves once its effect settles. */
  end(entry: RunningExecution): void {
    void entry.settled().then(() => {
      this.entries.delete(entry);
    });
  }

  /** Aborts every registered execution; returns how many were newly aborted. */
  cancelAll(): number {
    let cancelled = 0;
    for (const entry of this.entries) {
      if (entry.signal.aborted) continue;
      entry.halt.abort();
      cancelled += 1;
    }
    return cancelled;
  }

  /** Executions whose effect may still be running (or that have not returned). */
  unsettled(): number {
    return this.entries.size;
  }
}

/** One registry per process, shared by every ToolExecutionService instance. */
export const processRunningExecutions = new RunningExecutionRegistry();
