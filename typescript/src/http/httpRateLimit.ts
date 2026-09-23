import rateLimit from "@fastify/rate-limit";
import type { FastifyInstance, FastifyReply } from "fastify";

import { JarvisProblem } from "./problemDetails.js";
import type { RemoteGatewayConfig } from "./remoteGateway.js";

export const HTTP_RATE_LIMIT_MAX_KEYS = 10_000;

export type HttpRateLimitConfig = {
  max: number;
  timeWindowMs: number;
  /** Live client keys kept in this process. A new key is rejected when the map is full. */
  maxKeys?: number;
};

type RateBucket = { current: number; ttl: number; iterationStartMs: number };

type RateLimitStoreOptions = {
  cache?: number;
  continueExceeding?: boolean;
  exponentialBackoff?: boolean;
};

/**
 * In-memory counter for `@fastify/rate-limit`. A full map drops expired windows
 * and then rejects a new client key instead of evicting a live one.
 */
export class FailClosedRateLimitStore {
  private readonly maxKeys: number;
  private readonly continueExceeding: boolean;
  private readonly exponentialBackoff: boolean;
  private readonly buckets = new Map<string, RateBucket>();
  private readonly now: () => number;

  constructor(options: RateLimitStoreOptions = {}, now: () => number = Date.now) {
    this.maxKeys = options.cache ?? HTTP_RATE_LIMIT_MAX_KEYS;
    this.continueExceeding = options.continueExceeding ?? false;
    this.exponentialBackoff = options.exponentialBackoff ?? false;
    this.now = now;
  }

  incr(
    key: string,
    callback: (error: Error | null, result?: { current: number; ttl: number }) => void,
    timeWindow: number,
    max: number,
  ): void {
    const now = this.now();
    const existing = this.buckets.get(key);
    const expired = existing !== undefined && existing.iterationStartMs + timeWindow <= now;
    if (existing === undefined || expired) {
      if (existing === undefined && this.buckets.size >= this.maxKeys) {
        this.pruneExpired(now, timeWindow);
      }
      if (existing === undefined && this.buckets.size >= this.maxKeys) {
        callback(null, { current: max + 1, ttl: 1_000 });
        return;
      }
      const created = { current: 1, ttl: timeWindow, iterationStartMs: now };
      this.buckets.set(key, created);
      callback(null, created);
      return;
    }

    existing.current += 1;
    if (this.continueExceeding && existing.current > max) {
      existing.ttl = timeWindow;
      existing.iterationStartMs = now;
    } else if (this.exponentialBackoff && existing.current > max) {
      const backoffExponent = existing.current - max - 1;
      const ttl = timeWindow * 2 ** backoffExponent;
      existing.ttl = Number.isSafeInteger(ttl) ? ttl : Number.MAX_SAFE_INTEGER;
      existing.iterationStartMs = now;
    } else {
      existing.ttl = timeWindow - (now - existing.iterationStartMs);
    }
    callback(null, existing);
  }

  child(routeOptions: object): FailClosedRateLimitStore {
    const options = routeOptions as RateLimitStoreOptions;
    return new FailClosedRateLimitStore(
      {
        cache: options.cache ?? this.maxKeys,
        continueExceeding: options.continueExceeding ?? this.continueExceeding,
        exponentialBackoff: options.exponentialBackoff ?? this.exponentialBackoff,
      },
      this.now,
    );
  }

  private pruneExpired(now: number, timeWindow: number): void {
    for (const [key, bucket] of this.buckets) {
      if (bucket.iterationStartMs + timeWindow <= now) this.buckets.delete(key);
    }
  }
}

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

/**
 * Loopback HTTP uses `JARVIS_HTTP_RATE_LIMIT_*` (default 1000 requests / 60s).
 * When the remote gateway is configured, its existing
 * `JARVIS_RATE_LIMIT_*` budget is the only HTTP counter. The gateway's
 * in-memory buckets are not applied on this path.
 */
export function resolveHttpRateLimitConfig(
  env: NodeJS.ProcessEnv = process.env,
  remoteGateway?: RemoteGatewayConfig,
): HttpRateLimitConfig {
  if (remoteGateway !== undefined) {
    return {
      max: remoteGateway.rateLimitMaxRequests,
      timeWindowMs: remoteGateway.rateLimitWindowMs,
    };
  }
  return {
    max: boundedInteger(
      env.JARVIS_HTTP_RATE_LIMIT_MAX,
      "JARVIS_HTTP_RATE_LIMIT_MAX",
      1_000,
      1,
      100_000,
    ),
    timeWindowMs: boundedInteger(
      env.JARVIS_HTTP_RATE_LIMIT_WINDOW_MS,
      "JARVIS_HTTP_RATE_LIMIT_WINDOW_MS",
      60_000,
      100,
      3_600_000,
    ),
  };
}

function retryAfterSeconds(header: ReturnType<FastifyReply["getHeader"]>): number | undefined {
  if (typeof header === "number" && Number.isInteger(header)) return header;
  if (typeof header === "string" && /^\d+$/.test(header)) return Number(header);
  return undefined;
}

export async function registerHttpRateLimit(
  fastify: FastifyInstance,
  config: HttpRateLimitConfig,
): Promise<void> {
  const maxKeys = config.maxKeys ?? HTTP_RATE_LIMIT_MAX_KEYS;
  // The plugin constructs a custom store with its global options object, which
  // does not carry `cache`. Keep the cap on the instance explicitly.
  class BoundedRateLimitStore extends FailClosedRateLimitStore {
    constructor(options: RateLimitStoreOptions = {}) {
      super({ ...options, cache: options.cache ?? maxKeys });
    }
  }
  await fastify.register(rateLimit, {
    global: true,
    max: config.max,
    timeWindow: config.timeWindowMs,
    cache: maxKeys,
    store: BoundedRateLimitStore,
    errorResponseBuilder: () =>
      new JarvisProblem(
        429,
        "rate-limit-exceeded",
        "Too Many Requests",
        "The caller has exceeded the configured request rate.",
      ),
  });
  fastify.addHook("onSend", async (_request, reply, payload) => {
    if (reply.statusCode !== 429) return payload;
    const seconds = retryAfterSeconds(reply.getHeader("retry-after"));
    if (seconds === undefined) return payload;
    if (seconds < 1) reply.header("retry-after", "1");
    return payload;
  });
}
