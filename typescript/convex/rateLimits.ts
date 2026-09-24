import { RateLimiter } from "@convex-dev/rate-limiter";
import type { ComponentApi } from "@convex-dev/rate-limiter/_generated/component.js";
import { ConvexError } from "convex/values";

import { components } from "./_generated/api.js";
import type { MutationCtx } from "./_generated/server.js";

const MODEL_INVOCATION_LIMIT = "modelInvocation";
const DEFAULT_MODEL_INVOCATION_RATE = 120;
const DEFAULT_MODEL_INVOCATION_PERIOD_MS = 60_000;

/**
 * `components.rateLimiter` is the component installed by `convex.config.ts`.
 * The checked-in generated `components` type names that installation. The
 * constructor expects the component API shape, which is a narrower view of
 * the same reference.
 */
const rateLimiter = new RateLimiter(components.rateLimiter as unknown as ComponentApi);

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

export function modelInvocationLimitConfig(): {
  kind: "fixed window";
  rate: number;
  period: number;
} {
  return {
    kind: "fixed window",
    rate: boundedInteger(
      process.env.JARVIS_CONVEX_MODEL_INVOCATION_RATE,
      "JARVIS_CONVEX_MODEL_INVOCATION_RATE",
      DEFAULT_MODEL_INVOCATION_RATE,
      1,
      100_000,
    ),
    period: boundedInteger(
      process.env.JARVIS_CONVEX_MODEL_INVOCATION_PERIOD_MS,
      "JARVIS_CONVEX_MODEL_INVOCATION_PERIOD_MS",
      DEFAULT_MODEL_INVOCATION_PERIOD_MS,
      1_000,
      86_400_000,
    ),
  };
}

/**
 * Convex `retryAfter` is a millisecond delay. HTTP `Retry-After` is whole
 * seconds and at least 1. Values that are not a positive finite delay become
 * 1 second so a caller does not retry immediately on a malformed wait.
 */
export function retryAfterHeaderSeconds(retryAfterMs: number): number {
  if (!Number.isFinite(retryAfterMs) || retryAfterMs <= 0) return 1;
  return Math.min(86_400, Math.max(1, Math.ceil(retryAfterMs / 1_000)));
}

/**
 * Consumes one unit of the per-owner, per-provider model-invocation budget.
 * Throws `ConvexError` data `{ kind: "RateLimited", name, retryAfter }` when
 * the window is exhausted. `retryAfter` is milliseconds. Idempotent replays
 * must not call this.
 */
export async function consumeModelInvocationBudget(
  ctx: MutationCtx,
  ownerId: string,
  provider: string,
): Promise<void> {
  const status = await rateLimiter.limit(ctx, MODEL_INVOCATION_LIMIT, {
    key: `${ownerId}:${provider}`,
    config: modelInvocationLimitConfig(),
  });
  if (status.ok) return;
  throw new ConvexError({
    kind: "RateLimited",
    name: MODEL_INVOCATION_LIMIT,
    retryAfter: status.retryAfter,
  });
}
