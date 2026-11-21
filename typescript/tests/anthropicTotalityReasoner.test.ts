import assert from "node:assert/strict";
import { describe, it } from "node:test";

import { JarvisProblem } from "../src/http/problemDetails.js";
import { mapTotalityRouteError } from "../src/http/totalityController.js";
import { categorizeAnthropicRequestError } from "../src/integrations/anthropic/errorCategory.js";
import {
  AnthropicRequestError,
  AnthropicTotalityReasoner,
  resolveAnthropicTotalityConfig,
  type AnthropicTotalityConfig,
} from "../src/integrations/anthropic/totalityReasoner.js";
import type { TotalityRequest } from "../src/runtime/totalityContracts.js";
import { TotalityCallerDisconnected } from "../src/totality/callerLifetime.js";
import {
  resolveTotalityReasonerProviderName,
  resolveTotalityReasoningStatus,
} from "../src/totality/totalityFactory.js";
import type { TotalityReasoningContext } from "../src/totality/totalityPipeline.js";

const CONFIG: AnthropicTotalityConfig = {
  apiKey: "test-key",
  model: "claude-opus-5-5",
  effort: "low",
  timeoutMs: 5_000,
  maxOutputTokens: 1_234,
};

function makeRequest(): TotalityRequest {
  return {
    requestId: "request-123",
    projectId: "project-1",
    sessionId: "session-1",
    taskType: "engineering_analysis",
    domainContext: ["mechanical"],
    goal: "Review a fabricated bracket",
    constraints: [{ material: "steel" }],
    inputs: [{ thicknessMm: 6 }],
    outputStyle: "for_benny_engineering",
    actionPolicy: { maximumToolAuthority: "T1", requireApprovalBeforeExecution: true },
  };
}

function makeContext(): TotalityReasoningContext {
  return {
    proposedAt: "2026-07-16T00:00:00.000Z",
    project: {
      projectId: "project-1",
      projectName: "Bracket review",
      projectType: "engineering",
      status: "active",
      revision: 4,
      domains: ["mechanical"],
      summary: "Review a fabricated steel bracket.",
      updatedAt: "2026-07-15T23:00:00.000Z",
    },
  };
}

function draftJson(): string {
  return JSON.stringify({
    answer: "Use a gusseted bracket and verify the load path.",
    assumptions: ["Steel grade is unverified."],
    unknowns: ["Applied peak load is unknown."],
    risks: ["Weld toe fatigue."],
    controls: ["Inspect weld profile and proof-load the assembly."],
    unsupportedClaims: [],
    contradictions: [],
    memoryProposals: [],
    memoryRationale: "",
  });
}

function message(overrides: Record<string, unknown> = {}) {
  return {
    id: "msg_test",
    type: "message",
    role: "assistant",
    model: "claude-opus-5-5",
    stop_reason: "end_turn",
    stop_details: null,
    content: [
      { type: "thinking", thinking: "", signature: "sig" },
      { type: "text", text: draftJson() },
    ],
    usage: { input_tokens: 110, output_tokens: 40, cache_read_input_tokens: 10 },
    ...overrides,
  };
}

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json" },
  });
}

function captureFetch(response: () => Response) {
  const calls: Array<{ url: string; init: RequestInit | undefined }> = [];
  const fetchImpl = (async (input: string | URL | Request, init?: RequestInit) => {
    calls.push({ url: String(input), init });
    return response();
  }) as typeof fetch;
  return { calls, fetchImpl };
}

function headerOf(init: RequestInit | undefined, name: string): string | null {
  return new Headers(init?.headers as HeadersInit).get(name);
}

describe("Anthropic Totality reasoner", () => {
  it("sends one structured-output Messages request through the SDK and parses the draft", async () => {
    const { calls, fetchImpl } = captureFetch(() => jsonResponse(message()));
    const reasoner = new AnthropicTotalityReasoner(CONFIG, fetchImpl);
    const result = await reasoner.reason(makeRequest(), makeContext());

    assert.equal(calls.length, 1);
    assert.match(calls[0]!.url, /^https:\/\/api\.anthropic\.com\/v1\/messages(\?beta=true)?$/);
    // SDK 1.x sends the API key as a bearer credential.
    assert.equal(headerOf(calls[0]!.init, "authorization"), "Bearer test-key");
    assert.ok(!calls[0]!.url.includes("test-key"), "the key never appears in the URL");
    assert.match(
      headerOf(calls[0]!.init, "anthropic-beta") ?? "",
      /server-side-fallback-2026-07-01/,
    );
    const body = JSON.parse(String(calls[0]!.init?.body)) as Record<string, unknown>;
    assert.equal(body.model, "claude-opus-5-5");
    assert.equal(body.max_tokens, 1_234);
    assert.equal(body.fallbacks, "default");
    assert.equal(body.betas, undefined, "the beta flag is a header, not a body field");
    assert.equal(body.thinking, undefined, "thinking is left to the model default");
    const outputConfig = body.output_config as {
      effort: string;
      format: { type: string; schema: { required: string[] } };
    };
    assert.equal(outputConfig.effort, "low");
    assert.equal(outputConfig.format.type, "json_schema");
    assert.ok(outputConfig.format.schema.required.includes("memoryProposals"));
    const user = (body.messages as Array<{ content: string }>)[0]!.content;
    const input = JSON.parse(user) as Record<string, unknown>;
    assert.deepEqual(input.projectContext, makeContext().project);
    assert.equal(input.proposalTimestamp, makeContext().proposedAt);

    assert.equal(result.responseId, "msg_test");
    assert.deepEqual(result.modelUsage, {
      provider: "anthropic",
      model: "claude-opus-5-5",
      inputTokens: 110,
      outputTokens: 40,
      cachedInputTokens: 10,
    });
    assert.match(result.draft.answer, /gusseted bracket/);
  });

  it("budgets the exact dispatched body, without the credential", async () => {
    const { calls, fetchImpl } = captureFetch(() => jsonResponse(message()));
    const reasoner = new AnthropicTotalityReasoner(CONFIG, fetchImpl);
    const context = makeContext();
    context.project!.summary = "Brackets 🔩 and measurements. ".repeat(30);
    const serialized = reasoner.serializeRequest(makeRequest(), context);
    await reasoner.reason(makeRequest(), context);
    assert.equal(String(calls[0]!.init?.body), serialized);
    assert.ok(serialized.includes("Brackets 🔩"));
    assert.ok(!serialized.includes("test-key"));
  });

  it("treats a refusal as a non-retryable failure without reading content", async () => {
    const { fetchImpl } = captureFetch(() =>
      jsonResponse(
        message({
          stop_reason: "refusal",
          stop_details: { type: "refusal", category: null, explanation: null },
          content: [{ type: "text", text: "not json" }],
        }),
      ),
    );
    await assert.rejects(
      () => new AnthropicTotalityReasoner(CONFIG, fetchImpl).reason(makeRequest(), makeContext()),
      (error: unknown) =>
        error instanceof AnthropicRequestError &&
        !error.retryable &&
        /declined/.test(error.message),
    );
  });

  it("treats max_tokens as a failure instead of returning a truncated draft", async () => {
    const { fetchImpl } = captureFetch(() =>
      jsonResponse(message({ stop_reason: "max_tokens", content: [{ type: "text", text: "{" }] })),
    );
    await assert.rejects(
      () => new AnthropicTotalityReasoner(CONFIG, fetchImpl).reason(makeRequest(), makeContext()),
      (error: unknown) =>
        error instanceof AnthropicRequestError &&
        !error.retryable &&
        /did not finish normally: max_tokens/.test(error.message),
    );
  });

  for (const [status, retryable, category] of [
    [429, true, "rate_limited"],
    [401, false, "authentication_failed"],
    [400, false, "request_rejected"],
    [529, true, "dependency_failed"],
  ] as const) {
    it(`classifies HTTP ${status} as ${category} without retrying`, async () => {
      const { calls, fetchImpl } = captureFetch(() =>
        jsonResponse(
          { type: "error", error: { type: "api_error", message: `provider said ${status}` } },
          status,
        ),
      );
      const error = await new AnthropicTotalityReasoner(CONFIG, fetchImpl)
        .reason(makeRequest(), makeContext())
        .then(
          () => assert.fail("expected a failure"),
          (caught: unknown) => caught,
        );
      assert.equal(calls.length, 1);
      assert.ok(error instanceof AnthropicRequestError);
      assert.equal(error.status, status);
      assert.equal(error.retryable, retryable);
      assert.equal(error.message, `provider said ${status}`);
      assert.equal(categorizeAnthropicRequestError(error), category);
    });
  }

  it("maps an empty credit balance to quota exhausted", () => {
    const error = new AnthropicRequestError(
      "Your credit balance is too low to access the Anthropic API.",
      400,
      false,
    );
    assert.equal(categorizeAnthropicRequestError(error), "quota_exhausted");
    assert.throws(
      () => mapTotalityRouteError(error),
      (mapped: unknown) =>
        mapped instanceof JarvisProblem && mapped.slug === "reasoning-quota-exhausted",
    );
  });

  it("rejects an oversized response as non-retryable without including body content", async () => {
    const marker = "private-provider-body";
    const { calls, fetchImpl } = captureFetch(
      () =>
        new Response(JSON.stringify({ ...message(), padding: marker + "x".repeat(1_048_576) }), {
          status: 200,
          headers: { "content-type": "application/json" },
        }),
    );
    await assert.rejects(
      () => new AnthropicTotalityReasoner(CONFIG, fetchImpl).reason(makeRequest(), makeContext()),
      (error: unknown) =>
        error instanceof AnthropicRequestError &&
        !error.retryable &&
        /exceeds/.test(error.message) &&
        !error.message.includes(marker),
    );
    assert.equal(calls.length, 1);
  });

  it("reports a caller disconnect as a disconnect and aborts the provider call", async () => {
    const caller = new AbortController();
    let fetchSignal: AbortSignal | undefined;
    let started: () => void = () => {};
    const sent = new Promise<void>((resolve) => {
      started = resolve;
    });
    const fetchImpl = (async (_input: string | URL | Request, init?: RequestInit) => {
      fetchSignal = init?.signal ?? undefined;
      started();
      return new Promise<Response>((_resolve, reject) => {
        init?.signal?.addEventListener("abort", () => {
          const error = new Error("aborted");
          error.name = "AbortError";
          reject(error);
        });
      });
    }) as typeof fetch;
    const pending = new AnthropicTotalityReasoner(CONFIG, fetchImpl).reason(
      makeRequest(),
      makeContext(),
      caller.signal,
    );
    await sent;
    caller.abort();
    await assert.rejects(pending, (error: unknown) => error instanceof TotalityCallerDisconnected);
    assert.equal(fetchSignal?.aborted, true);
  });

  it("blocks caller authority violations before any network request", async () => {
    const { calls, fetchImpl } = captureFetch(() => jsonResponse(message()));
    const request = makeRequest();
    request.actionPolicy.maximumToolAuthority = "T0";
    await assert.rejects(
      () => new AnthropicTotalityReasoner(CONFIG, fetchImpl).reason(request, makeContext()),
      /exceeds the request action policy/,
    );
    assert.equal(calls.length, 0);
  });
});

describe("Anthropic Totality configuration", () => {
  it("requires the server-side key and defaults the model and effort", () => {
    assert.throws(() => resolveAnthropicTotalityConfig({}), /ANTHROPIC_API_KEY is required/);
    const config = resolveAnthropicTotalityConfig({ ANTHROPIC_API_KEY: "k" });
    assert.equal(config.model, "claude-opus-5-5");
    assert.equal(config.effort, "low");
    assert.throws(
      () =>
        resolveAnthropicTotalityConfig({
          ANTHROPIC_API_KEY: "k",
          TOTALITY_ANTHROPIC_EFFORT: "max",
        }),
      /low, medium or high/,
    );
  });

  it("is selectable as a Totality provider and reports only the model in status", () => {
    assert.equal(resolveTotalityReasonerProviderName("anthropic"), "anthropic");
    const saved = { ...process.env };
    try {
      process.env.TOTALITY_REASONER_PROVIDER = "anthropic";
      process.env.ANTHROPIC_API_KEY = "secret-value";
      delete process.env.TOTALITY_ANTHROPIC_MODEL;
      const status = resolveTotalityReasoningStatus("convex");
      assert.equal(status.status, "configured");
      assert.equal(status.provider, "anthropic");
      assert.equal(status.model, "claude-opus-5-5");
      assert.ok(!JSON.stringify(status).includes("secret-value"));
    } finally {
      process.env = saved;
    }
  });
});
