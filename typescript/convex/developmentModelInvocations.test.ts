import { anyApi } from "convex/server";
import { convexTest } from "convex-test";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import schema from "./schema.js";
import { modules } from "./test.setup.js";

const SERVICE_TOKEN = "development-model-invocation-service-token";

function harness() {
  return convexTest(schema, modules);
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

function invocation(overrides: Record<string, unknown> = {}) {
  return {
    serviceToken: SERVICE_TOKEN,
    subjectId: "mission-1",
    eventId: "model-call-1",
    correlationId: "correlation-1",
    workUnitId: "mission-1:implementation",
    purpose: "implementation",
    provider: "openai",
    model: "gpt-5.6-terra",
    inputTokens: 1000,
    outputTokens: 250,
    cachedInputTokens: 500,
    contextSize: 1500,
    latencyMs: 800,
    retryCount: 0,
    estimatedCost: 1.25,
    costProvenance: "ESTIMATED" as const,
    escalationDecision: "none" as const,
    ...overrides,
  };
}

describe("durable Development model invocation telemetry", () => {
  it("records trusted runtime metadata as an append-only mission event", async () => {
    const t = harness();
    await seedSubject(t);

    const first = await t.mutation(anyApi.developmentState.recordModelInvocation, invocation());
    const replay = await t.mutation(anyApi.developmentState.recordModelInvocation, invocation());

    expect(replay._id).toEqual(first._id);
    expect(first).toMatchObject({
      eventType: "DEV_MODEL_INVOCATION_RECORDED",
      subjectId: "mission-1",
      correlationId: "correlation-1",
      payload: {
        provider: "openai",
        model: "gpt-5.6-terra",
        cachedInputTokens: 500,
      },
    });
  });

  it("rejects untrusted self-reported model identity and changed event replay", async () => {
    const t = harness();
    await seedSubject(t);

    await expect(
      t.mutation(
        anyApi.developmentState.recordModelInvocation,
        invocation({ provider: "self", model: "unlimited" }),
      ),
    ).rejects.toThrow(/trusted model registry/i);

    await t.mutation(anyApi.developmentState.recordModelInvocation, invocation());
    await expect(
      t.mutation(anyApi.developmentState.recordModelInvocation, invocation({ outputTokens: 251 })),
    ).rejects.toThrow(/event ID.*different/i);
  });
});
