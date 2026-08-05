import type { ReconciliationCycleObservation } from "../reconciliation/reconciliationScheduler.js";

type PostHogEventName =
  | "jarvis.operator_action"
  | "jarvis.tool_outcome"
  | "jarvis.boundary_latency"
  | "jarvis.runtime_failure"
  | "jarvis.usage";
type PostHogProperty = string | number | boolean;
type PostHogEvent = {
  event: PostHogEventName;
  properties: Readonly<Record<string, PostHogProperty>>;
};

type FetchLike = typeof fetch;
type Environment = Readonly<Record<string, string | undefined>>;

export type PostHogTelemetry = {
  readonly enabled: boolean;
  capture(event: PostHogEvent): void;
  flush(): Promise<void>;
};

type HttpBoundaryInput = {
  method: string;
  statusCode: number;
  durationMs: number;
};

type BoundaryOutcome = "success" | "failure" | "skipped";

type McpBoundaryInput = {
  outcome: Exclude<BoundaryOutcome, "skipped">;
  durationMs: number;
};

type ReconciliationCycleInput = {
  outcome: BoundaryOutcome;
  processed: number;
  durationMs: number;
};

const MAX_DURATION_MS = 10 * 60 * 1_000;
const MAX_COUNT = 100;
const DEFAULT_TIMEOUT_MS = 250;
const DEFAULT_POSTHOG_HOST = "https://us.i.posthog.com";
const DISTINCT_ID = "jarvis-development";

function noOpTelemetry(): PostHogTelemetry {
  return {
    enabled: false,
    capture: () => {},
    flush: async () => {},
  };
}

function boundedDuration(value: number): number {
  if (!Number.isFinite(value)) return 0;
  return Math.min(MAX_DURATION_MS, Math.max(0, Math.round(value)));
}

function boundedCount(value: number): number {
  if (!Number.isFinite(value)) return 0;
  return Math.min(MAX_COUNT, Math.max(0, Math.round(value)));
}

function safeMethod(value: string): string {
  return /^(GET|POST|PUT|PATCH|DELETE|OPTIONS|HEAD)$/.test(value) ? value : "OTHER";
}

function hasControlCharacters(value: string): boolean {
  for (const character of value) {
    const code = character.charCodeAt(0);
    if (code < 32 || code === 127) return true;
  }
  return false;
}

function sharedProperties(boundary: "http" | "mcp" | "reconciliation") {
  return {
    environment: "development" as const,
    distinct_id: DISTINCT_ID,
    boundary,
  };
}

function captureFailure(
  telemetry: PostHogTelemetry,
  boundary: "http" | "mcp" | "reconciliation",
  failureKind: "http_5xx" | "mcp_request_failed" | "reconciliation_cycle_failed",
): void {
  telemetry.capture({
    event: "jarvis.runtime_failure",
    properties: {
      ...sharedProperties(boundary),
      failure_kind: failureKind,
    },
  });
}

export function captureHttpBoundary(
  telemetry: PostHogTelemetry,
  input: HttpBoundaryInput,
): void {
  const outcome = input.statusCode >= 500 ? "failure" : "success";
  telemetry.capture({
    event: "jarvis.operator_action",
    properties: {
      ...sharedProperties("http"),
      operation: "http_request",
      method: safeMethod(input.method),
      outcome,
      status_code: Math.min(599, Math.max(100, Math.round(input.statusCode))),
    },
  });
  telemetry.capture({
    event: "jarvis.boundary_latency",
    properties: {
      ...sharedProperties("http"),
      operation: "http_request",
      duration_ms: boundedDuration(input.durationMs),
    },
  });
  telemetry.capture({
    event: "jarvis.usage",
    properties: {
      ...sharedProperties("http"),
      metric: "http_requests",
      value: 1,
    },
  });
  if (outcome === "failure") captureFailure(telemetry, "http", "http_5xx");
}

export function captureMcpBoundary(telemetry: PostHogTelemetry, input: McpBoundaryInput): void {
  telemetry.capture({
    event: "jarvis.tool_outcome",
    properties: {
      ...sharedProperties("mcp"),
      operation: "mcp_request",
      outcome: input.outcome,
    },
  });
  telemetry.capture({
    event: "jarvis.boundary_latency",
    properties: {
      ...sharedProperties("mcp"),
      operation: "mcp_request",
      duration_ms: boundedDuration(input.durationMs),
    },
  });
  telemetry.capture({
    event: "jarvis.usage",
    properties: {
      ...sharedProperties("mcp"),
      metric: "mcp_requests",
      value: 1,
    },
  });
  if (input.outcome === "failure") {
    captureFailure(telemetry, "mcp", "mcp_request_failed");
  }
}

export function captureReconciliationCycle(
  telemetry: PostHogTelemetry,
  input: ReconciliationCycleInput,
): void {
  telemetry.capture({
    event: "jarvis.tool_outcome",
    properties: {
      ...sharedProperties("reconciliation"),
      operation: "reconciliation_cycle",
      outcome: input.outcome,
    },
  });
  telemetry.capture({
    event: "jarvis.boundary_latency",
    properties: {
      ...sharedProperties("reconciliation"),
      operation: "reconciliation_cycle",
      duration_ms: boundedDuration(input.durationMs),
    },
  });
  telemetry.capture({
    event: "jarvis.usage",
    properties: {
      ...sharedProperties("reconciliation"),
      metric: "reconciliation_items_processed",
      value: boundedCount(input.processed),
    },
  });
  if (input.outcome === "failure") {
    captureFailure(telemetry, "reconciliation", "reconciliation_cycle_failed");
  }
}

export function createReconciliationTelemetryObserver(
  telemetry: PostHogTelemetry,
): (observation: ReconciliationCycleObservation) => void {
  let startedAt: number | undefined;
  return (observation) => {
    if (observation.type === "started") {
      startedAt = performance.now();
      return;
    }
    const durationMs = startedAt === undefined ? 0 : performance.now() - startedAt;
    startedAt = undefined;
    captureReconciliationCycle(telemetry, {
      outcome:
        observation.type === "completed"
          ? "success"
          : observation.type === "skipped"
            ? "skipped"
            : "failure",
      processed: observation.type === "completed" ? observation.processed : 0,
      durationMs,
    });
  };
}

function parseTimeout(environment: Environment): number | null {
  const raw = environment.POSTHOG_TIMEOUT_MS;
  if (raw === undefined) return DEFAULT_TIMEOUT_MS;
  if (!/^\d+$/.test(raw.trim())) return null;
  const value = Number(raw);
  return Number.isSafeInteger(value) && value >= 25 && value <= 2_000 ? value : null;
}

function resolveEndpoint(environment: Environment): { endpoint: string; apiKey: string; timeoutMs: number } | null {
  if (
    environment.JARVIS_ENVIRONMENT !== "development" ||
    environment.JARVIS_POSTHOG_ENABLED !== "true"
  ) {
    return null;
  }

  const apiKey = environment.POSTHOG_PROJECT_API_KEY?.trim();
  if (
    !apiKey ||
    apiKey.length > 256 ||
    !apiKey.startsWith("phc_") ||
    /\s/.test(apiKey) || hasControlCharacters(apiKey)
  ) {
    return null;
  }

  const rawHost = environment.POSTHOG_HOST?.trim() || DEFAULT_POSTHOG_HOST;
  let host: URL;
  try {
    host = new URL(rawHost);
  } catch {
    return null;
  }
  if (host.protocol !== "https:" || host.username || host.password || host.search || host.hash) {
    return null;
  }

  const timeoutMs = parseTimeout(environment);
  if (timeoutMs === null) return null;

  const basePath = host.pathname.replace(/\/+$/, "");
  return {
    endpoint: `${host.origin}${basePath}/capture/`,
    apiKey,
    timeoutMs,
  };
}

class EnabledPostHogTelemetry implements PostHogTelemetry {
  readonly enabled = true;
  private readonly pending = new Set<Promise<void>>();

  constructor(
    private readonly endpoint: string,
    private readonly apiKey: string,
    private readonly timeoutMs: number,
    private readonly fetchImpl: FetchLike,
  ) {}

  capture(event: PostHogEvent): void {
    const task = this.send(event);
    this.pending.add(task);
    void task
      .finally(() => {
        this.pending.delete(task);
      })
      .catch(() => {});
  }

  async flush(): Promise<void> {
    while (this.pending.size > 0) {
      await Promise.allSettled([...this.pending]);
    }
  }

  private async send(event: PostHogEvent): Promise<void> {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), this.timeoutMs);
    timeout.unref?.();
    try {
      await this.fetchImpl(this.endpoint, {
        method: "POST",
        headers: {
          "content-type": "application/json",
          accept: "application/json",
        },
        body: JSON.stringify({
          api_key: this.apiKey,
          event: event.event,
          properties: event.properties,
        }),
        signal: controller.signal,
      });
    } catch {
      // Telemetry is intentionally best-effort and never affects business work.
    } finally {
      clearTimeout(timeout);
    }
  }
}

export function createPostHogTelemetryFromEnv(
  environment: Environment = process.env,
  fetchImpl: FetchLike = fetch,
): PostHogTelemetry {
  const config = resolveEndpoint(environment);
  return config === null
    ? noOpTelemetry()
    : new EnabledPostHogTelemetry(
        config.endpoint,
        config.apiKey,
        config.timeoutMs,
        fetchImpl,
      );
}
