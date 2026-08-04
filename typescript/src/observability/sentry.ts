import { randomUUID } from "node:crypto";

export type SentryEvent = {
  type: "error" | "transaction";
  event_id: string;
  timestamp: number;
  platform: "node";
  release: string;
  environment: string;
  level: "error" | "info";
  tags: Record<string, string>;
  exception?: {
    values: Array<{
      type: string;
      value: string;
    }>;
  };
  transaction?: string;
  measurements?: Record<string, { value: number; unit: "millisecond" | "none" }>;
};

export interface SentryTransport {
  send(event: SentryEvent): Promise<void>;
}

export type SentryContext = {
  operation: string;
  route?: string;
  method?: string;
  requestId?: string;
  tags?: Record<string, string>;
};

export type SentryMeasurement = {
  operation: string;
  durationMs: number;
  success: boolean;
  tags?: Record<string, string>;
  measurements?: Record<string, number>;
};

export type SentryRuntime = {
  readonly enabled: boolean;
  captureError(error: unknown, context: SentryContext): Promise<void>;
  recordMeasurement(input: SentryMeasurement): Promise<void>;
};

export type SentryRuntimeConfig = {
  enabled: boolean;
  dsn?: string;
  release: string;
  environment: string;
  secrets?: readonly string[];
};

const SAFE_TAG = /^[A-Za-z0-9._:/-]{1,128}$/;
const SAFE_ENVIRONMENT = /^[A-Za-z0-9._:/-]{1,64}$/;
const MAX_ERROR_VALUE_LENGTH = 512;
const ROUTE_SEGMENTS = new Set([
  "api",
  "v1",
  "healthz",
  "help",
  "status",
  "tasks",
  "reminders",
  "clients",
  "projects",
  "quotes",
  "errands",
  "builds",
  "build-logs",
  "upgrades",
  "assets",
  "preferences",
  "notes",
  "brief",
  "operations",
  "inbox",
  "activity",
  "reconciliations",
  "tool-actions",
  "memory",
  "totality",
  "complete",
  "approve",
  "reject",
  "revoke",
  "execute",
]);

function requiredIdentifier(value: string, field: string, maximum: number): string {
  const clean = value.trim();
  if (!SAFE_ENVIRONMENT.test(clean) || clean.length > maximum) {
    throw new Error(`${field} must contain only safe release/environment characters.`);
  }
  return clean;
}

function redactText(value: string, secrets: readonly string[]): string {
  let result = value.slice(0, MAX_ERROR_VALUE_LENGTH);
  for (const secret of secrets) {
    const clean = secret.trim();
    if (clean) result = result.split(clean).join("[REDACTED]");
  }
  return result
    .replace(/Bearer\s+[^\s,;]+/gi, "Bearer [REDACTED]")
    .replace(
      /(?:password|passwd|secret|token|api[_-]?key|authorization|dsn)\s*[:=]\s*[^\s,;]+/gi,
      "[REDACTED]",
    )
    .replace(/[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}/gi, "[EMAIL]")
    .replace(/https?:\/\/[^\s,;]+/gi, "[URL]")
    .slice(0, MAX_ERROR_VALUE_LENGTH);
}

function safeTag(value: string | undefined): string | undefined {
  if (value === undefined) return undefined;
  const clean = value.trim();
  return SAFE_TAG.test(clean) ? clean : undefined;
}

function stableRoute(value: string | undefined): string {
  const path = (value ?? "unknown").split("?", 1)[0];
  if (path === "unknown" || path === "") return "unknown";
  return (
    path
      .split("/")
      .map((segment, index) => {
        if (index === 0 || segment === "") return "";
        if (segment.startsWith(":") || ROUTE_SEGMENTS.has(segment)) return segment;
        return ":param";
      })
      .join("/") || "/"
  );
}

function tagsFor(context: SentryContext): Record<string, string> {
  const candidates: Record<string, string | undefined> = {
    operation: context.operation,
    route: stableRoute(context.route),
    method: context.method?.toUpperCase(),
    request_id: context.requestId,
    ...context.tags,
  };
  return Object.fromEntries(
    Object.entries(candidates)
      .map(([key, value]) => [key, safeTag(value)])
      .filter((entry): entry is [string, string] => entry[1] !== undefined),
  );
}

function errorDetails(error: unknown, secrets: readonly string[]): { type: string; value: string } {
  if (error instanceof Error) {
    const type = safeTag(error.name) ?? "Error";
    const value = redactText(error.message || "Unhandled runtime error", secrets);
    return { type, value: value || "Unhandled runtime error" };
  }
  return {
    type: "UnhandledRuntimeError",
    value: redactText(String(error), secrets) || "Unhandled runtime error",
  };
}

function dsnEndpoint(dsn: string): string {
  let parsed: URL;
  try {
    parsed = new URL(dsn);
  } catch {
    throw new Error("SENTRY_DSN must be a valid HTTPS DSN.");
  }
  if (parsed.protocol !== "https:" || !parsed.username || parsed.password) {
    throw new Error("SENTRY_DSN must be a valid HTTPS DSN.");
  }
  const pathSegments = parsed.pathname.split("/").filter(Boolean);
  const projectId = pathSegments.pop();
  if (!projectId || !/^[0-9]+$/.test(projectId)) {
    throw new Error("SENTRY_DSN must contain a numeric project ID.");
  }
  const prefix = pathSegments.length > 0 ? `/${pathSegments.join("/")}` : "";
  return `${parsed.origin}${prefix}/api/${projectId}/envelope/?sentry_version=7&sentry_key=${encodeURIComponent(parsed.username)}&sentry_client=jarvis-runtime/1`;
}

class SentryEnvelopeTransport implements SentryTransport {
  private readonly endpoint: string;

  constructor(dsn: string) {
    this.endpoint = dsnEndpoint(dsn);
  }

  async send(event: SentryEvent): Promise<void> {
    const envelopeHeader = JSON.stringify({
      event_id: event.event_id,
      sent_at: new Date().toISOString(),
    });
    const itemHeader = JSON.stringify({ type: event.type });
    const body = `${envelopeHeader}\n${itemHeader}\n${JSON.stringify(event)}\n`;
    const response = await fetch(this.endpoint, {
      method: "POST",
      headers: { "content-type": "application/x-sentry-envelope" },
      body,
    });
    if (!response.ok) throw new Error(`Sentry transport returned HTTP ${response.status}.`);
  }
}

const disabledRuntime: SentryRuntime = {
  enabled: false,
  async captureError(): Promise<void> {},
  async recordMeasurement(): Promise<void> {},
};

export function createSentryRuntime(
  config: SentryRuntimeConfig,
  transport?: SentryTransport,
): SentryRuntime {
  const release = requiredIdentifier(config.release, "SENTRY_RELEASE", 128);
  const environment = requiredIdentifier(config.environment, "SENTRY_ENVIRONMENT", 64);
  if (!config.enabled) return disabledRuntime;

  const sender = transport ?? new SentryEnvelopeTransport(config.dsn ?? "");
  const secrets = config.secrets ?? [];
  const send = async (event: SentryEvent): Promise<void> => {
    try {
      await sender.send(event);
    } catch {
      // Telemetry is best-effort. An unavailable Sentry endpoint must not
      // change Jarvis request, tool, or reconciliation outcomes.
    }
  };

  return {
    enabled: true,
    async captureError(error, context) {
      const details = errorDetails(error, secrets);
      await send({
        type: "error",
        event_id: randomUUID().replace(/-/g, ""),
        timestamp: Date.now() / 1000,
        platform: "node",
        release,
        environment,
        level: "error",
        tags: tagsFor(context),
        exception: { values: [details] },
      });
    },
    async recordMeasurement(input) {
      const durationMs = Number.isFinite(input.durationMs)
        ? Math.max(0, Math.min(input.durationMs, 86_400_000))
        : 0;
      const measurements: Record<string, { value: number; unit: "millisecond" | "none" }> = {
        latency_ms: { value: durationMs, unit: "millisecond" },
      };
      for (const [name, value] of Object.entries(input.measurements ?? {})) {
        if (SAFE_TAG.test(name) && Number.isFinite(value)) {
          measurements[name] = { value: Math.max(0, value), unit: "none" };
        }
      }
      await send({
        type: "transaction",
        event_id: randomUUID().replace(/-/g, ""),
        timestamp: Date.now() / 1000,
        platform: "node",
        release,
        environment,
        level: input.success ? "info" : "error",
        tags: {
          ...tagsFor({ operation: input.operation, tags: input.tags }),
          outcome: input.success ? "success" : "failure",
        },
        transaction: safeTag(input.operation) ?? "jarvis.operation",
        measurements,
      });
    },
  };
}

export function createSentryRuntimeFromEnv(
  environment: NodeJS.ProcessEnv = process.env,
): SentryRuntime {
  const dsn = environment.SENTRY_DSN?.trim();
  const release = environment.SENTRY_RELEASE?.trim() || environment.JARVIS_SOURCE_VERSION?.trim() || "development";
  const sentryEnvironment = environment.SENTRY_ENVIRONMENT?.trim() || "development";
  const secrets = [
    environment.JARVIS_SERVICE_TOKEN,
    environment.JARVIS_SERVICE_TOKEN_PREVIOUS,
    environment.JARVIS_APPROVAL_TOKEN,
    environment.JARVIS_APPROVAL_TOKEN_PREVIOUS,
    environment.OPENAI_API_KEY,
    environment.MICROSOFT_CLIENT_SECRET,
  ].filter((value): value is string => value !== undefined);
  return createSentryRuntime(
    {
      enabled: dsn !== undefined,
      ...(dsn === undefined ? {} : { dsn }),
      release,
      environment: sentryEnvironment,
      secrets,
    },
  );
}

export { stableRoute };
