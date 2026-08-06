import assert from "node:assert/strict";
import { describe, it } from "node:test";

import {
  OpenAIRequestError,
  OpenAITotalityReasoner,
  resolveOpenAITotalityConfig,
} from "../src/integrations/openai/totalityReasoner.js";
import type { TotalityRequest } from "../src/runtime/totalityContracts.js";
import type { TotalityReasoningContext } from "../src/totality/totalityPipeline.js";

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

function successfulPayload(memoryProposals: unknown[] = []) {
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
              memoryProposals,
              memoryRationale:
                memoryProposals.length === 0
                  ? ""
                  : "Retain the supplied bracket dimensions for approval.",
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
      { apiKey: "test-key", model: "gpt-5.6", timeoutMs: 5_000, maxOutputTokens: 1_234 },
      fetchImpl,
    );
    const result = await reasoner.reason(makeRequest(), makeContext());

    assert.equal(capturedUrl, "https://api.openai.com/v1/responses");
    assert.equal(capturedInit?.method, "POST");
    const headers = capturedInit?.headers as Record<string, string>;
    assert.equal(headers.Authorization, "Bearer test-key");
    assert.equal(headers["X-Client-Request-Id"], "request-123");

    const body = JSON.parse(String(capturedInit?.body)) as Record<string, unknown>;
    assert.equal(body.store, false);
    assert.equal(body.max_output_tokens, 1_234);
    assert.deepEqual(body.tools, undefined);
    const input = JSON.parse(String(body.input)) as Record<string, unknown>;
    assert.deepEqual(input.projectContext, makeContext().project);
    assert.equal(input.proposalTimestamp, makeContext().proposedAt);
    assert.equal(result.responseId, "resp_test");
    assert.match(result.draft.answer, /gusseted bracket/);
    assert.deepEqual(result.draft.memoryProposals, []);
  });

  it("parses typed memory proposals without allowing model-owned IDs or timestamps", async () => {
    const fetchImpl = (async () =>
      new Response(
        JSON.stringify(
          successfulPayload([
            {
              kind: "measurement",
              name: "Bracket thickness",
              value: 6,
              unit: "mm",
              tolerance: null,
              source: "request input",
            },
          ]),
        ),
        { status: 200, headers: { "Content-Type": "application/json" } },
      )) as typeof fetch;
    const reasoner = new OpenAITotalityReasoner(
      { apiKey: "test-key", model: "gpt-5.6", timeoutMs: 5_000, maxOutputTokens: 4_096 },
      fetchImpl,
    );

    const result = await reasoner.reason(makeRequest(), makeContext());

    assert.deepEqual(result.draft.memoryProposals, [
      {
        kind: "measurement",
        name: "Bracket thickness",
        value: 6,
        unit: "mm",
        tolerance: null,
        source: "request input",
      },
    ]);
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
      { apiKey: "test-key", model: "gpt-5.6", timeoutMs: 5_000, maxOutputTokens: 4_096 },
      fetchImpl,
    );

    await assert.rejects(
      () => reasoner.reason(makeRequest(), makeContext()),
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
      { apiKey: "test-key", model: "gpt-5.6", timeoutMs: 5_000, maxOutputTokens: 4_096 },
      fetchImpl,
    );

    await assert.rejects(
      () => reasoner.reason(makeRequest(), makeContext()),
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
      { apiKey: "test-key", model: "gpt-5.6", timeoutMs: 5_000, maxOutputTokens: 4_096 },
      fetchImpl,
    );
    const request = makeRequest();
    request.actionPolicy.maximumToolAuthority = "T0";

    await assert.rejects(
      () => reasoner.reason(request, makeContext()),
      /exceeds the request action policy/,
    );
    assert.equal(called, false);
  });

  it("blocks invalid client request IDs before making a network request", async () => {
    let called = false;
    const fetchImpl = (async () => {
      called = true;
      return new Response(JSON.stringify(successfulPayload()), { status: 200 });
    }) as typeof fetch;
    const reasoner = new OpenAITotalityReasoner(
      { apiKey: "test-key", model: "gpt-5.6", timeoutMs: 5_000, maxOutputTokens: 4_096 },
      fetchImpl,
    );
    const request = makeRequest();
    request.requestId = "bad\nrequest-id";

    await assert.rejects(() => reasoner.reason(request, makeContext()), /visible ASCII characters/);
    assert.equal(called, false);
  });
});
