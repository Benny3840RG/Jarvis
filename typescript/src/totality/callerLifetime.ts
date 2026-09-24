// Caller-disconnect cancellation adapted from OpenClaw's in-process lifetime split.
// Inspected: v2026.9.5 ec9c1a13db8938e5a3eaa51fca2e981cde2395a9
//   src/shared/async-work-scope.ts (runOutsideAsyncWorkScope, getAsyncWorkSignal)
//   src/infra/http-response-body-timeout.ts (abort cancels the reader)
// and v2026.9.6 eb377ac59e6c9fd6c7705028034812becf00271b
//   src/gateway/server-methods/shared-types.ts (caller AbortSignal is never a frame field)
//   src/gateway/talk/handlers/voice.ts (abort means the caller disconnected)
// Jarvis keeps its own AbortSignal wiring. The AsyncLocalStorage work scope,
// retry supervisor, gateway, and voice runtime are not imported.
// See docs/third-party/openclaw/LICENSE.

export class TotalityCallerDisconnected extends Error {
  readonly code = "caller-disconnected" as const;

  constructor() {
    super("Totality caller disconnected.");
    this.name = "TotalityCallerDisconnected";
  }
}

export type WorkDurability = "request-bound" | "durable";

/** Explicit delegated work. `durable` is required so disconnect cannot imply it. */
export type TotalityDelegatedJob = {
  durable: boolean;
  run: (signal: AbortSignal | undefined) => Promise<void>;
};

export type CallerResponse = {
  destroyed?: boolean;
  writableEnded: boolean;
  writableFinished: boolean;
  once(event: "close", listener: () => void): void;
};

/**
 * Request-bound work receives the caller signal. Durable work is outside that
 * lifetime: disconnect does not abort it and does not wait for it.
 */
export function signalForWork(
  durability: WorkDurability,
  caller: AbortSignal | undefined,
): AbortSignal | undefined {
  if (durability === "durable") return undefined;
  return caller;
}

export function assertExplicitDurability(jobs: readonly TotalityDelegatedJob[]): void {
  for (const job of jobs) {
    if (job.durable !== true && job.durable !== false) {
      throw new TypeError("Delegated Totality work must set durable to true or false.");
    }
  }
}

export function throwIfCallerDisconnected(signal: AbortSignal | undefined): void {
  if (signal?.aborted) throw new TotalityCallerDisconnected();
}

/**
 * Own one provider timeout and forward an optional caller signal onto it.
 * Durable jobs must not pass the caller signal here.
 */
export function linkProviderCancellation(options: { timeoutMs: number; caller?: AbortSignal }): {
  signal: AbortSignal;
  dispose: () => void;
} {
  const controller = new AbortController();
  const timeout = setTimeout(() => {
    if (!controller.signal.aborted) controller.abort();
  }, options.timeoutMs);
  const onCallerAbort = () => {
    if (controller.signal.aborted) return;
    const reason = options.caller?.reason;
    controller.abort(reason instanceof Error ? reason : new TotalityCallerDisconnected());
  };
  if (options.caller?.aborted) onCallerAbort();
  else options.caller?.addEventListener("abort", onCallerAbort, { once: true });
  return {
    signal: controller.signal,
    dispose() {
      clearTimeout(timeout);
      options.caller?.removeEventListener("abort", onCallerAbort);
    },
  };
}

export function asCallerDisconnected(caller: AbortSignal | undefined, error: unknown): unknown {
  if (error instanceof TotalityCallerDisconnected) return error;
  if (caller?.aborted) return new TotalityCallerDisconnected();
  return error;
}

/**
 * Abort when the HTTP response closes before it finishes. A finished response
 * also emits close and must not cancel work that already completed.
 */
export function bindCallerDisconnect(response: CallerResponse): AbortSignal {
  const controller = new AbortController();
  const abort = () => {
    if (!controller.signal.aborted) controller.abort(new TotalityCallerDisconnected());
  };
  const abandoned = () => !response.writableEnded && !response.writableFinished;
  if (response.destroyed && abandoned()) {
    abort();
    return controller.signal;
  }
  response.once("close", () => {
    if (abandoned()) abort();
  });
  return controller.signal;
}
