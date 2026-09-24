export type RemoteGatewayRequest = {
  origin?: string;
  forwardedProto?: string;
  contentLength?: number;
  clientKey: string;
};

export type RemoteGatewayDecision =
  | { allowed: true }
  | {
      allowed: false;
      code: "tls-required" | "origin-not-allowed" | "request-too-large" | "rate-limit-exceeded";
      retryAfterSeconds?: number;
    };

export type RemoteGatewayConfig = {
  allowedOrigins: readonly string[];
  maxRequestBytes: number;
  rateLimitMaxRequests: number;
  rateLimitWindowMs: number;
  requireForwardedHttps: true;
  rateBuckets: Map<string, { windowStartedAt: number; count: number }>;
  trustedProxy: readonly string[];
};

type GatewayEnvironment = NodeJS.ProcessEnv;

export const MAX_RATE_BUCKETS = 10_000;

function optionalText(value: string | undefined): string | undefined {
  const cleaned = value?.trim();
  return cleaned ? cleaned : undefined;
}

function boundedInteger(
  value: string | undefined,
  field: string,
  defaultValue: number,
  min: number,
  max: number,
): number {
  const raw = optionalText(value) ?? String(defaultValue);
  if (!/^\d+$/.test(raw)) {
    throw new Error(`${field} must be an integer between ${min} and ${max}.`);
  }
  const parsed = Number(raw);
  if (!Number.isSafeInteger(parsed) || parsed < min || parsed > max) {
    throw new Error(`${field} must be an integer between ${min} and ${max}.`);
  }
  return parsed;
}

function parseAllowedOrigins(value: string | undefined): string[] {
  const raw = optionalText(value);
  if (raw === undefined)
    throw new Error("JARVIS_ALLOWED_ORIGINS is required for the remote gateway.");
  const origins = [
    ...new Set(
      raw
        .split(",")
        .map((item) => item.trim())
        .filter(Boolean),
    ),
  ];
  if (origins.length === 0) {
    throw new Error("JARVIS_ALLOWED_ORIGINS must contain at least one HTTPS origin.");
  }
  for (const origin of origins) {
    let parsed: URL;
    try {
      parsed = new URL(origin);
    } catch {
      throw new Error("JARVIS_ALLOWED_ORIGINS must contain valid HTTPS origins.");
    }
    if (
      parsed.protocol !== "https:" ||
      parsed.username ||
      parsed.password ||
      parsed.pathname !== "/" ||
      parsed.search ||
      parsed.hash
    ) {
      throw new Error("JARVIS_ALLOWED_ORIGINS must contain valid HTTPS origins.");
    }
  }
  return origins;
}

const IPV4_OR_CIDR = /^(\d{1,3}\.){3}\d{1,3}(\/\d{1,2})?$/;
const IPV6_OR_CIDR = /^[0-9a-fA-F:]+(\/\d{1,3})?$/;

function parseTrustedProxy(value: string | undefined): string[] {
  const raw = optionalText(value);
  if (raw === undefined)
    throw new Error(
      "JARVIS_TRUSTED_PROXY is required for the remote gateway -- it names the exact upstream TLS terminator address(es)/CIDR(s) allowed to set forwarded-request headers. Without it, X-Forwarded-Proto and X-Forwarded-For could not be trusted from any peer.",
    );
  const entries = [
    ...new Set(
      raw
        .split(",")
        .map((item) => item.trim())
        .filter(Boolean),
    ),
  ];
  if (entries.length === 0) {
    throw new Error("JARVIS_TRUSTED_PROXY must contain at least one IP address or CIDR range.");
  }
  for (const entry of entries) {
    if (!IPV4_OR_CIDR.test(entry) && !IPV6_OR_CIDR.test(entry)) {
      throw new Error(
        `JARVIS_TRUSTED_PROXY entry "${entry}" is not a recognisable IP address or CIDR range.`,
      );
    }
  }
  return entries;
}

export function resolveRemoteGatewayConfig(
  env: GatewayEnvironment = process.env,
): RemoteGatewayConfig {
  if (env.JARVIS_REMOTE_GATEWAY_ENABLED !== "true") {
    throw new Error(
      "Remote gateway HTTP exposure requires JARVIS_REMOTE_GATEWAY_ENABLED=true and the approved gateway boundary.",
    );
  }
  if (env.JARVIS_TLS_TERMINATED !== "true") {
    throw new Error("Remote HTTP exposure requires JARVIS_TLS_TERMINATED=true.");
  }
  return {
    allowedOrigins: parseAllowedOrigins(env.JARVIS_ALLOWED_ORIGINS),
    maxRequestBytes: boundedInteger(
      env.JARVIS_MAX_REQUEST_BYTES,
      "JARVIS_MAX_REQUEST_BYTES",
      1_048_576,
      1_024,
      10_485_760,
    ),
    rateLimitMaxRequests: boundedInteger(
      env.JARVIS_RATE_LIMIT_MAX_REQUESTS,
      "JARVIS_RATE_LIMIT_MAX_REQUESTS",
      60,
      1,
      10_000,
    ),
    rateLimitWindowMs: boundedInteger(
      env.JARVIS_RATE_LIMIT_WINDOW_MS,
      "JARVIS_RATE_LIMIT_WINDOW_MS",
      60_000,
      100,
      3_600_000,
    ),
    requireForwardedHttps: true,
    rateBuckets: new Map(),
    trustedProxy: parseTrustedProxy(env.JARVIS_TRUSTED_PROXY),
  };
}

export type RemoteGatewayEvaluationOptions = {
  /**
   * The HTTP adapter passes false. `@fastify/rate-limit` is the only request
   * counter on that path, including when the remote gateway is enabled.
   * Direct callers keep these in-memory buckets.
   */
  enforceRateLimit?: boolean;
};

export function evaluateRemoteGatewayRequest(
  policy: RemoteGatewayConfig,
  request: RemoteGatewayRequest,
  now = Date.now(),
  options: RemoteGatewayEvaluationOptions = {},
): RemoteGatewayDecision {
  if (request.forwardedProto?.toLowerCase() !== "https") {
    return { allowed: false, code: "tls-required" };
  }
  if (request.origin !== undefined && !policy.allowedOrigins.includes(request.origin)) {
    return { allowed: false, code: "origin-not-allowed" };
  }
  if (
    request.contentLength !== undefined &&
    (!Number.isSafeInteger(request.contentLength) || request.contentLength > policy.maxRequestBytes)
  ) {
    return { allowed: false, code: "request-too-large" };
  }

  if (options.enforceRateLimit === false) return { allowed: true };

  if (policy.rateBuckets.size >= MAX_RATE_BUCKETS) {
    for (const [key, candidate] of policy.rateBuckets) {
      if (now - candidate.windowStartedAt >= policy.rateLimitWindowMs) {
        policy.rateBuckets.delete(key);
      }
    }
  }

  const existing = policy.rateBuckets.get(request.clientKey);
  if (existing === undefined && policy.rateBuckets.size >= MAX_RATE_BUCKETS) {
    return { allowed: false, code: "rate-limit-exceeded", retryAfterSeconds: 1 };
  }
  const bucket =
    existing === undefined || now - existing.windowStartedAt >= policy.rateLimitWindowMs
      ? { windowStartedAt: now, count: 0 }
      : existing;
  if (bucket.count >= policy.rateLimitMaxRequests) {
    const retryAfterSeconds = Math.max(
      1,
      Math.ceil((policy.rateLimitWindowMs - (now - bucket.windowStartedAt)) / 1_000),
    );
    policy.rateBuckets.set(request.clientKey, bucket);
    return { allowed: false, code: "rate-limit-exceeded", retryAfterSeconds };
  }
  bucket.count += 1;
  policy.rateBuckets.set(request.clientKey, bucket);
  return { allowed: true };
}
