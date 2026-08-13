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
  flush(): Promise<PostHogFlushReceipt>;
};

export type PostHogFlushReceipt = Readonly<{
  attempted: number;
  accepted: number;
  failed: number;
}>;

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
  failureCount: number;
  durationMs: number;
};

const MAX_DURATION_MS = 10 * 60 * 1_000;
const MAX_COUNT = 100;
const DEFAULT_TIMEOUT_MS = 250;
const MAX_RUNTIME_TIMEOUT_MS = 2_000;
const MAX_COMMISSIONING_TIMEOUT_MS = 10_000;
const MAX_PENDING_EVENTS = 32;
const DEFAULT_POSTHOG_HOST = "https://us.i.posthog.com";
const DISTINCT_ID = "jarvis-development";

function noOpTelemetry(): PostHogTelemetry {
  return {
    enabled: false,
    capture: () => {},
    flush: async () => Object.freeze({ attempted: 0, accepted: 0, failed: 0 }),
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
    boundary,
  };
}

function captureFailure(
  telemetry: PostHogTelemetry,
  boundary: "http" | "mcp" | "reconciliation",
  failureKind: "http_4xx" | "http_5xx" | "mcp_request_failed" | "reconciliation_cycle_failed",
): void {
  telemetry.capture({
    event: "jarvis.runtime_failure",
    properties: {
      ...sharedProperties(boundary),
      failure_kind: failureKind,
    },
  });
}

export function captureHttpBoundary(telemetry: PostHogTelemetry, input: HttpBoundaryInput): void {
  const outcome = input.statusCode >= 400 ? "failure" : "success";
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
  if (outcome === "failure") {
    captureFailure(telemetry, "http", input.statusCode >= 500 ? "http_5xx" : "http_4xx");
  }
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
      failure_count: boundedCount(input.failureCount),
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
  if (input.outcome === "failure" || input.failureCount > 0) {
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
          ? observation.failureCount === 0
            ? "success"
            : "failure"
          : observation.type === "skipped"
            ? "skipped"
            : "failure",
      processed: observation.type === "completed" ? observation.processed : 0,
      failureCount: observation.type === "completed" ? observation.failureCount : 0,
      durationMs,
    });
  };
}

function parseTimeout(environment: Environment, maximumMs: number): number | null {
  const raw = environment.POSTHOG_TIMEOUT_MS;
  if (raw === undefined) return DEFAULT_TIMEOUT_MS;
  if (!/^\d+$/.test(raw.trim())) return null;
  const value = Number(raw);
  return Number.isSafeInteger(value) && value >= 25 && value <= maximumMs ? value : null;
}

function resolveEndpoint(
  environment: Environment,
  maximumTimeoutMs: number,
): { endpoint: string; apiKey: string; timeoutMs: number; sourceVersion: string } | null {
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
    /\s/.test(apiKey) ||
    hasControlCharacters(apiKey)
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

  const timeoutMs = parseTimeout(environment, maximumTimeoutMs);
  if (timeoutMs === null) return null;
  const sourceVersion = environment.JARVIS_SOURCE_VERSION?.trim() || "development";
  if (
    sourceVersion.length < 7 ||
    sourceVersion.length > 64 ||
    !/^[A-Za-z0-9][A-Za-z0-9._/+:@-]*$/.test(sourceVersion)
  ) {
    return null;
  }

  const basePath = host.pathname.replace(/\/+$/, "");
  return {
    endpoint: `${host.origin}${basePath}/i/v0/e/`,
    apiKey,
    timeoutMs,
    sourceVersion,
  };
}

class EnabledPostHogTelemetry implements PostHogTelemetry {
  readonly enabled = true;
  private readonly pending = new Set<Promise<void>>();
  private attempted = 0;
  private accepted = 0;
  private failed = 0;

  constructor(
    private readonly endpoint: string,
    private readonly apiKey: string,
    private readonly timeoutMs: number,
    private readonly sourceVersion: string,
    private readonly fetchImpl: FetchLike,
  ) {}

  capture(event: PostHogEvent): void {
    this.attempted += 1;
    if (this.pending.size >= MAX_PENDING_EVENTS) {
      this.failed += 1;
      return;
    }
    const task = this.send(event).then((accepted) => {
      if (accepted) this.accepted += 1;
      else this.failed += 1;
    });
    this.pending.add(task);
    void task
      .finally(() => {
        this.pending.delete(task);
      })
      .catch(() => {});
  }

  async flush(): Promise<PostHogFlushReceipt> {
    while (this.pending.size > 0) {
      await Promise.allSettled([...this.pending]);
    }
    const receipt = Object.freeze({
      attempted: this.attempted,
      accepted: this.accepted,
      failed: this.failed,
    });
    this.attempted = 0;
    this.accepted = 0;
    this.failed = 0;
    return receipt;
  }

  private async send(event: PostHogEvent): Promise<boolean> {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), this.timeoutMs);
    try {
      const response = await this.fetchImpl(this.endpoint, {
        method: "POST",
        headers: {
          "content-type": "application/json",
          accept: "application/json",
        },
        body: JSON.stringify({
          api_key: this.apiKey,
          distinct_id: DISTINCT_ID,
          event: event.event,
          properties: {
            ...event.properties,
            source_version: this.sourceVersion,
          },
        }),
        signal: controller.signal,
      });
      return response.ok;
    } catch {
      // Telemetry is intentionally best-effort and never affects business work.
      return false;
    } finally {
      clearTimeout(timeout);
    }
  }
}

export function createPostHogTelemetryFromEnv(
  environment: Environment = process.env,
  fetchImpl: FetchLike = fetch,
): PostHogTelemetry {
  return createPostHogTelemetry(environment, fetchImpl, MAX_RUNTIME_TIMEOUT_MS);
}

export function createPostHogCommissioningTelemetryFromEnv(
  environment: Environment = process.env,
  fetchImpl: FetchLike = fetch,
): PostHogTelemetry {
  return createPostHogTelemetry(environment, fetchImpl, MAX_COMMISSIONING_TIMEOUT_MS);
}

function createPostHogTelemetry(
  environment: Environment,
  fetchImpl: FetchLike,
  maximumTimeoutMs: number,
): PostHogTelemetry {
  const config = resolveEndpoint(environment, maximumTimeoutMs);
  return config === null
    ? noOpTelemetry()
    : new EnabledPostHogTelemetry(
        config.endpoint,
        config.apiKey,
        config.timeoutMs,
        config.sourceVersion,
        fetchImpl,
      );
}
