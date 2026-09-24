import { isRateLimitError } from "@convex-dev/rate-limiter";
import { register as registerRateLimiter } from "@convex-dev/rate-limiter/test";
import { anyApi } from "convex/server";
import { convexTest } from "convex-test";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { modelInvocationLimitConfig, retryAfterHeaderSeconds } from "./rateLimits.js";
import schema from "./schema.js";
import { modules } from "./test.setup.js";

const SERVICE_TOKEN = "model-invocation-rate-limit-service-token";

function harness() {
  const t = convexTest(schema, modules);
  registerRateLimiter(t);
  return t;
}

beforeEach(() => vi.stubEnv("JARVIS_SERVICE_TOKEN", SERVICE_TOKEN));
afterEach(() => vi.unstubAllEnvs());

async function seedSubject(t: ReturnType<typeof harness>) {
  const now = Date.now();
  await t.run((ctx) =>
    ctx.db.insert("developmentSubjects", {
      ownerId: "jarvis-cli",
      subjectId: "mission-1",
      state: "BUILDING",
      subjectVersion: 2,
      projectionVersion: 2,
      reducerVersion: "DevelopmentReducer/v1",
      createdAt: now,
      updatedAt: now,
    }),
  );
}

function invocation(eventId: string, provider: "openai" | "gemini" = "openai") {
  return {
    serviceToken: SERVICE_TOKEN,
    subjectId: "mission-1",
    eventId,
    correlationId: "correlation-1",
    workUnitId: "mission-1:implementation",
    purpose: "implementation",
    provider,
    model: provider === "openai" ? "gpt-5.6-terra" : "gemini-2.5-flash",
    inputTokens: 1000,
    outputTokens: 250,
    latencyMs: 800,
    retryCount: 0,
    estimatedCost: 1.25,
    costProvenance: "ESTIMATED" as const,
    escalationDecision: "none" as const,
  };
}

describe("model invocation Convex rate limit", () => {
  it("converts a millisecond retryAfter into an HTTP Retry-After of at least one second", () => {
    expect(retryAfterHeaderSeconds(1)).toBe(1);
    expect(retryAfterHeaderSeconds(1_000)).toBe(1);
    expect(retryAfterHeaderSeconds(1_001)).toBe(2);
    expect(retryAfterHeaderSeconds(0)).toBe(1);
    expect(retryAfterHeaderSeconds(Number.NaN)).toBe(1);
  });

  it("fails closed when the configured budget is not an integer", () => {
    vi.stubEnv("JARVIS_CONVEX_MODEL_INVOCATION_RATE", "many");
    expect(() => modelInvocationLimitConfig()).toThrow(/JARVIS_CONVEX_MODEL_INVOCATION_RATE/);
  });

  it("rejects a new invocation once the provider window is exhausted and leaves retryAfter", async () => {
    vi.stubEnv("JARVIS_CONVEX_MODEL_INVOCATION_RATE", "1");
    vi.stubEnv("JARVIS_CONVEX_MODEL_INVOCATION_PERIOD_MS", "60000");
    const t = harness();
    await seedSubject(t);

    await t.mutation(anyApi.developmentState.recordModelInvocation, invocation("model-call-1"));
    await t.mutation(anyApi.developmentState.recordModelInvocation, invocation("model-call-1"));

    await expect(
      t.mutation(anyApi.developmentState.recordModelInvocation, invocation("model-call-2")),
    ).rejects.toSatisfy((error: unknown) => {
      if (!isRateLimitError(error)) return false;
      const retryAfter = error.data.retryAfter;
      return (
        error.data.name === "modelInvocation" &&
        Number.isSafeInteger(retryAfter) &&
        retryAfter >= 1 &&
        retryAfter <= 60_000 &&
        retryAfterHeaderSeconds(retryAfter) >= 1
      );
    });

    await t.mutation(
      anyApi.developmentState.recordModelInvocation,
      invocation("model-call-3", "gemini"),
    );
  });
});
