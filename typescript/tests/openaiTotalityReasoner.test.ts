import assert from "node:assert/strict";
import { describe, it } from "node:test";

import {
  OpenAIRequestError,
  OpenAITotalityReasoner,
  resolveOpenAITotalityConfig,
} from "../src/integrations/openai/totalityReasoner.js";
import type { TotalityRequest } from "../src/runtime/totalityContracts.js";

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
    actionPolicy: {
      maximumToolAuthority: "T1",
      requireApprovalBeforeExecution: true,
    },
  };
}

function successfulPayload() {
  return {
    id: "resp_test",
    output: [
      {
        type: "message",
        content: [
          {
            type: "output_text",
            text: JSON.stringify({
              answer: "Use a gusseted bracket and verify the load path.",
              assumptions: ["Steel grade is unverified."],
              unknowns: ["Applied peak load is unknown."],
              risks: ["Weld toe fatigue."],
              controls: ["Inspect weld profile and proof-load the assembly."],
              unsupportedClaims: [],
              contradictions: [],
            }),
          },
        ],
      },
    ],
  };
}

describe("OpenAI Totality reasoner", () => {
  it("builds a proposal-only Responses API request and parses structured output", async () => {
    let capturedUrl = "";
    let capturedInit: RequestInit | undefined;
    const fetchImpl = (async (input: string | URL | Request, init?: RequestInit) => {
      capturedUrl = String(input);
      capturedInit = init;
      return new Response(JSON.stringify(successfulPayload()), {
        status: 200,
        headers: { "Content-Type": "application/json" },
      });
    }) as typeof fetch;

    const reasoner = new OpenAITotalityReasoner(
      { apiKey: "test-key", model: "gpt-5.6", timeoutMs: 5_000 },
      fetchImpl,
    );
    const result = await reasoner.reason(makeRequest());

    assert.equal(capturedUrl, "https://api.openai.com/v1/responses");
    assert.equal(capturedInit?.method, "POST");
    const headers = capturedInit?.headers as Record<string, string>;
    assert.equal(headers.Authorization, "Bearer test-key");
    assert.equal(headers["X-Client-Request-Id"], "request-123");

    const body = JSON.parse(String(capturedInit?.body)) as Record<string, unknown>;
    assert.equal(body.store, false);
    assert.deepEqual(body.tools, undefined);
    assert.equal(result.responseId, "resp_test");
    assert.match(result.draft.answer, /gusseted bracket/);
  });

  it("requires a server-side API key", () => {
    assert.throws(
      () => resolveOpenAITotalityConfig({ OPENAI_MODEL: "gpt-5.6" }),
      /OPENAI_API_KEY is required/,
    );
  });

  it("classifies rate limits as retryable without exposing the full response", async () => {
    const fetchImpl = (async () =>
      new Response(JSON.stringify({ error: { message: "Rate limit reached." } }), {
        status: 429,
        headers: { "Content-Type": "application/json" },
      })) as typeof fetch;
    const reasoner = new OpenAITotalityReasoner(
      { apiKey: "test-key", model: "gpt-5.6", timeoutMs: 5_000 },
      fetchImpl,
    );

    await assert.rejects(
      () => reasoner.reason(makeRequest()),
      (error: unknown) =>
        error instanceof OpenAIRequestError && error.status === 429 && error.retryable,
    );
  });

  it("classifies non-JSON upstream server failures as retryable", async () => {
    const fetchImpl = (async () =>
      new Response("upstream unavailable", {
        status: 503,
        headers: { "Content-Type": "text/plain" },
      })) as typeof fetch;
    const reasoner = new OpenAITotalityReasoner(
      { apiKey: "test-key", model: "gpt-5.6", timeoutMs: 5_000 },
      fetchImpl,
    );

    await assert.rejects(
      () => reasoner.reason(makeRequest()),
      (error: unknown) =>
        error instanceof OpenAIRequestError && error.status === 503 && error.retryable,
    );
  });

  it("blocks caller authority violations before making a network request", async () => {
    let called = false;
    const fetchImpl = (async () => {
      called = true;
      return new Response(JSON.stringify(successfulPayload()), { status: 200 });
    }) as typeof fetch;
    const reasoner = new OpenAITotalityReasoner(
      { apiKey: "test-key", model: "gpt-5.6", timeoutMs: 5_000 },
      fetchImpl,
    );
    const request = makeRequest();
    request.actionPolicy.maximumToolAuthority = "T0";

    await assert.rejects(() => reasoner.reason(request), /exceeds the request action policy/);
    assert.equal(called, false);
  });

  it("blocks invalid client request IDs before making a network request", async () => {
    let called = false;
    const fetchImpl = (async () => {
      called = true;
      return new Response(JSON.stringify(successfulPayload()), { status: 200 });
    }) as typeof fetch;
    const reasoner = new OpenAITotalityReasoner(
      { apiKey: "test-key", model: "gpt-5.6", timeoutMs: 5_000 },
      fetchImpl,
    );
    const request = makeRequest();
    request.requestId = "bad\nrequest-id";

    await assert.rejects(() => reasoner.reason(request), /visible ASCII characters/);
    assert.equal(called, false);
  });
});
