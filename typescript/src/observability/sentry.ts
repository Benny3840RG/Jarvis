import { randomUUID } from "node:crypto";

export type ObservabilityLevel = "info" | "warning" | "error" | "fatal";

export type ObservabilityContext = Readonly<{
  requestId?: string;
  method?: string;
  path?: string;
  statusCode?: number;
  durationMs?: number;
  phase?: string;
  tags?: Readonly<Record<string, string>>;
}>;

export type HttpRequestObservation = Required<
  Pick<ObservabilityContext, "method" | "path" | "statusCode" | "durationMs" | "requestId">
>;

export type ObservabilityReporter = {
  captureException(error: unknown, context?: ObservabilityContext): Promise<void>;
  captureMessage(
    message: string,
    level: ObservabilityLevel,
    context?: ObservabilityContext,
  ): Promise<void>;
  recordHttpRequest(observation: HttpRequestObservation): Promise<void>;
};

export const NOOP_OBSERVABILITY_REPORTER: ObservabilityReporter = {
  async captureException(): Promise<void> {},
  async captureMessage(): Promise<void> {},
  async recordHttpRequest(): Promise<void> {},
};

type Environment = Readonly<Record<string, string | undefined>>;

type SentryConfig = {
  dsn: string;
  envelopeUrl: string;
  environment: string;
  release: string | null;
  timeoutMs: number;
  latencyThresholdMs: number;
  secrets: readonly string[];
};

type SentryReporterDependencies = {
  fetch?: typeof globalThis.fetch;
  now?: () => Date;
};

const DEFAULT_TIMEOUT_MS = 1_500;
const DEFAULT_LATENCY_THRESHOLD_MS = 2_000;
const MAX_TIMEOUT_MS = 10_000;
const MAX_LATENCY_THRESHOLD_MS = 60_000;

function parsePositiveInteger(
  value: string | undefined,
  fallback: number,
  maximum: number,
  name: string,
): number {
  if (value === undefined || value.trim() === "") return fallback;
  if (!/^\d+$/.test(value)) throw new Error(`${name} must be a positive integer.`);
  const parsed = Number(value);
  if (!Number.isSafeInteger(parsed) || parsed <= 0 || parsed > maximum) {
    throw new Error(`${name} must be between 1 and ${maximum}.`);
  }
  return parsed;
}

function resolveEnvelopeUrl(dsn: string): string {
  let parsed: URL;
  try {
    parsed = new URL(dsn);
  } catch {
    throw new Error("JARVIS_SENTRY_DSN must be an absolute Sentry DSN URL.");
  }

  if (parsed.protocol !== "https:" && parsed.protocol !== "http:") {
    throw new Error("JARVIS_SENTRY_DSN must use http or https.");
  }
  if (parsed.username.trim() === "") {
    throw new Error("JARVIS_SENTRY_DSN must include the Sentry public key.");
  }
  const projectId = parsed.pathname.split("/").filter(Boolean).at(-1);
  if (projectId === undefined || !/^[A-Za-z0-9_-]+$/.test(projectId)) {
    throw new Error("JARVIS_SENTRY_DSN must include a project identifier path.");
  }

  return `${parsed.origin}/api/${projectId}/envelope/`;
}

function nonEmpty(value: string | undefined): string | null {
  const trimmed = value?.trim();
  return trimmed === undefined || trimmed === "" ? null : trimmed;
}

export function resolveSentryConfig(
  environment: Environment = process.env,
  secrets: readonly string[] = [],
): SentryConfig | null {
  const dsn = nonEmpty(environment.JARVIS_SENTRY_DSN);
  if (dsn === null) return null;

  return {
    dsn,
    envelopeUrl: resolveEnvelopeUrl(dsn),
    environment: nonEmpty(environment.JARVIS_SENTRY_ENVIRONMENT) ?? "development",
    release: nonEmpty(environment.JARVIS_SOURCE_VERSION),
    timeoutMs: parsePositiveInteger(
      environment.JARVIS_SENTRY_TIMEOUT_MS,
      DEFAULT_TIMEOUT_MS,
      MAX_TIMEOUT_MS,
      "JARVIS_SENTRY_TIMEOUT_MS",
    ),
    latencyThresholdMs: parsePositiveInteger(
      environment.JARVIS_SENTRY_LATENCY_THRESHOLD_MS,
      DEFAULT_LATENCY_THRESHOLD_MS,
      MAX_LATENCY_THRESHOLD_MS,
      "JARVIS_SENTRY_LATENCY_THRESHOLD_MS",
    ),
    secrets: secrets.filter((secret) => secret.trim() !== ""),
  };
}

function sentryEventId(): string {
  return randomUUID().replaceAll("-", "");
}

function sentryTimestamp(now: Date): number {
  return now.getTime() / 1_000;
}

function pathOnly(path: string | undefined): string | undefined {
  if (path === undefined) return undefined;
  const stripped = path.split("?", 1)[0];
  return stripped.startsWith("/") ? stripped : "/";
}

function redact(value: string, secrets: readonly string[]): string {
  let redacted = value;
  for (const secret of secrets) redacted = redacted.split(secret).join("[REDACTED]");
  return redacted
    .replace(/(Authorization\s*:\s*Bearer\s+)[^\s"',]+/gi, "$1[REDACTED]")
    .replace(/(Bearer\s+)[A-Za-z0-9._~+\/-]+/g, "$1[REDACTED]")
    .replace(/\bsk-(?:proj-)?[A-Za-z0-9_-]{8,}\b/g, "[REDACTED_OPENAI_KEY]");
}

function errorName(error: unknown): string {
  return error instanceof Error && error.name.trim() !== "" ? error.name : "Error";
}

function errorMessage(error: unknown, secrets: readonly string[]): string {
  const raw = error instanceof Error ? error.message : String(error);
  return redact(raw, secrets);
}

function stackTrace(error: unknown, secrets: readonly string[]): string | undefined {
  if (!(error instanceof Error) || error.stack === undefined) return undefined;
  return redact(error.stack, secrets);
}

function safeExtra(context: ObservabilityContext | undefined): Record<string, string | number> {
  const extra: Record<string, string | number> = {};
  if (context?.requestId !== undefined) extra.requestId = context.requestId;
  if (context?.method !== undefined) extra.method = context.method;
  if (context?.path !== undefined) extra.path = pathOnly(context.path) ?? "/";
  if (context?.statusCode !== undefined) extra.statusCode = context.statusCode;
  if (context?.durationMs !== undefined) extra.durationMs = Math.round(context.durationMs);
  if (context?.phase !== undefined) extra.phase = context.phase;
  return extra;
}

function tagsFor(context: ObservabilityContext | undefined): Record<string, string> {
  return {
    ...(context?.tags ?? {}),
    ...(context?.phase === undefined ? {} : { phase: context.phase }),
  };
}

function envelope(config: SentryConfig, event: Record<string, unknown>, now: Date): string {
  return [
    JSON.stringify({
      dsn: config.dsn,
      sent_at: now.toISOString(),
      sdk: { name: "jarvis.sentry-envelope", version: "0.1.0" },
    }),
    JSON.stringify({ type: "event" }),
    JSON.stringify(event),
  ].join("\n");
}

export class SentryEnvelopeReporter implements ObservabilityReporter {
  private readonly fetch: typeof globalThis.fetch;
  private readonly now: () => Date;

  constructor(
    private readonly config: SentryConfig,
    dependencies: SentryReporterDependencies = {},
  ) {
    this.fetch = dependencies.fetch ?? globalThis.fetch.bind(globalThis);
    this.now = dependencies.now ?? (() => new Date());
  }

  async captureException(error: unknown, context: ObservabilityContext = {}): Promise<void> {
    await this.send({
      event_id: sentryEventId(),
      timestamp: sentryTimestamp(this.now()),
      platform: "node",
      level: "error",
      environment: this.config.environment,
      ...(this.config.release === null ? {} : { release: this.config.release }),
      exception: {
        values: [
          {
            type: errorName(error),
            value: errorMessage(error, this.config.secrets),
            ...(stackTrace(error, this.config.secrets) === undefined
              ? {}
              : { stacktrace: { frames: [], raw_stacktrace: stackTrace(error, this.config.secrets) } }),
          },
        ],
      },
      tags: tagsFor(context),
      extra: safeExtra(context),
    });
  }

  async captureMessage(
    message: string,
    level: ObservabilityLevel,
    context: ObservabilityContext = {},
  ): Promise<void> {
    await this.send({
      event_id: sentryEventId(),
      timestamp: sentryTimestamp(this.now()),
      platform: "node",
      level,
      message: redact(message, this.config.secrets),
      environment: this.config.environment,
      ...(this.config.release === null ? {} : { release: this.config.release }),
      tags: tagsFor(context),
      extra: safeExtra(context),
    });
  }

  async recordHttpRequest(observation: HttpRequestObservation): Promise<void> {
    const roundedDurationMs = Math.round(observation.durationMs);
    if (
      observation.statusCode < 500 &&
      roundedDurationMs < this.config.latencyThresholdMs
    ) {
      return;
    }

    await this.captureMessage(
      observation.statusCode >= 500
        ? "Jarvis HTTP request failed."
        : "Jarvis HTTP request latency threshold exceeded.",
      observation.statusCode >= 500 ? "error" : "warning",
      {
        requestId: observation.requestId,
        method: observation.method,
        path: observation.path,
        statusCode: observation.statusCode,
        durationMs: roundedDurationMs,
        tags: {
          component: "http",
          signal: observation.statusCode >= 500 ? "failure" : "latency",
        },
      },
    );
  }

  private async send(event: Record<string, unknown>): Promise<void> {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), this.config.timeoutMs);
    try {
      await this.fetch(this.config.envelopeUrl, {
        method: "POST",
        headers: { "Content-Type": "application/x-sentry-envelope" },
        body: envelope(this.config, event, this.now()),
        signal: controller.signal,
      });
    } catch {
      // Observability must never take down Jarvis or leak provider details.
    } finally {
      clearTimeout(timeout);
    }
  }
}

export function createSentryReporterFromEnv(
  environment: Environment = process.env,
  dependencies: SentryReporterDependencies & { secrets?: readonly string[] } = {},
): ObservabilityReporter {
  const config = resolveSentryConfig(environment, dependencies.secrets ?? []);
  return config === null
    ? NOOP_OBSERVABILITY_REPORTER
    : new SentryEnvelopeReporter(config, dependencies);
}
