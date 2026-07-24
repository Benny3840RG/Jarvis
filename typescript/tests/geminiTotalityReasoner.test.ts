import assert from "node:assert/strict";
import { describe, it } from "node:test";

import {
  GeminiRequestError,
  GeminiTotalityReasoner,
  resolveGeminiTotalityConfig,
} from "../src/integrations/gemini/totalityReasoner.js";
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
    responseId: "resp_test",
    candidates: [
      {
        finishReason: "STOP",
        content: {
          parts: [
            {
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
      },
    ],
  };
}

describe("Gemini Totality reasoner", () => {
  it("builds a generateContent request with the API key as a header, never a URL parameter", async () => {
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

    const reasoner = new GeminiTotalityReasoner(
      { apiKey: "test-key", model: "gemini-2.5-flash", timeoutMs: 5_000 },
      fetchImpl,
    );
    const result = await reasoner.reason(makeRequest(), makeContext());

    assert.equal(
      capturedUrl,
      "https://generativelanguage.googleapis.com/v1beta/models/gemini-2.5-flash:generateContent",
    );
    assert.ok(!capturedUrl.includes("key="), "the API key must never appear in the URL");
    assert.equal(capturedInit?.method, "POST");
    const headers = capturedInit?.headers as Record<string, string>;
    assert.equal(headers["x-goog-api-key"], "test-key");
    assert.equal(headers.Authorization, undefined);
    assert.equal(headers["X-Client-Request-Id"], "request-123");

    const body = JSON.parse(String(capturedInit?.body)) as Record<string, unknown>;
    assert.equal(
      (body.generationConfig as Record<string, unknown>).responseMimeType,
      "application/json",
    );
    const userPart = (
      (body.contents as Array<{ parts: Array<{ text: string }> }>)[0]!.parts[0] as {
        text: string;
      }
    ).text;
    const input = JSON.parse(userPart) as Record<string, unknown>;
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
    const reasoner = new GeminiTotalityReasoner(
      { apiKey: "test-key", model: "gemini-2.5-flash", timeoutMs: 5_000 },
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
      () => resolveGeminiTotalityConfig({ GEMINI_MODEL: "gemini-2.5-flash" }),
      /GEMINI_API_KEY is required/,
    );
  });

  it("classifies rate limits as retryable without exposing the full response", async () => {
    const fetchImpl = (async () =>
      new Response(JSON.stringify({ error: { message: "Rate limit reached." } }), {
        status: 429,
        headers: { "Content-Type": "application/json" },
      })) as typeof fetch;
    const reasoner = new GeminiTotalityReasoner(
      { apiKey: "test-key", model: "gemini-2.5-flash", timeoutMs: 5_000 },
      fetchImpl,
    );

    await assert.rejects(
      () => reasoner.reason(makeRequest(), makeContext()),
      (error: unknown) =>
        error instanceof GeminiRequestError && error.status === 429 && error.retryable,
    );
  });

  it("classifies non-JSON upstream server failures as retryable", async () => {
    const fetchImpl = (async () =>
      new Response("upstream unavailable", {
        status: 503,
        headers: { "Content-Type": "text/plain" },
      })) as typeof fetch;
    const reasoner = new GeminiTotalityReasoner(
      { apiKey: "test-key", model: "gemini-2.5-flash", timeoutMs: 5_000 },
      fetchImpl,
    );

    await assert.rejects(
      () => reasoner.reason(makeRequest(), makeContext()),
      (error: unknown) =>
        error instanceof GeminiRequestError && error.status === 503 && error.retryable,
    );
  });

  it("treats a blocked prompt as a failure instead of silently returning a partial draft", async () => {
    const fetchImpl = (async () =>
      new Response(JSON.stringify({ promptFeedback: { blockReason: "SAFETY" }, candidates: [] }), {
        status: 200,
        headers: { "Content-Type": "application/json" },
      })) as typeof fetch;
    const reasoner = new GeminiTotalityReasoner(
      { apiKey: "test-key", model: "gemini-2.5-flash", timeoutMs: 5_000 },
      fetchImpl,
    );

    await assert.rejects(() => reasoner.reason(makeRequest(), makeContext()), /blocked the prompt/);
  });

  it("treats a non-STOP finish reason as a failure instead of returning truncated output", async () => {
    const fetchImpl = (async () =>
      new Response(
        JSON.stringify({
          responseId: "resp_truncated",
          candidates: [{ finishReason: "MAX_TOKENS", content: { parts: [{ text: "{" }] } }],
        }),
        { status: 200, headers: { "Content-Type": "application/json" } },
      )) as typeof fetch;
    const reasoner = new GeminiTotalityReasoner(
      { apiKey: "test-key", model: "gemini-2.5-flash", timeoutMs: 5_000 },
      fetchImpl,
    );

    await assert.rejects(
      () => reasoner.reason(makeRequest(), makeContext()),
      /did not finish normally/,
    );
  });

  it("blocks caller authority violations before making a network request", async () => {
    let called = false;
    const fetchImpl = (async () => {
      called = true;
      return new Response(JSON.stringify(successfulPayload()), { status: 200 });
    }) as typeof fetch;
    const reasoner = new GeminiTotalityReasoner(
      { apiKey: "test-key", model: "gemini-2.5-flash", timeoutMs: 5_000 },
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
    const reasoner = new GeminiTotalityReasoner(
      { apiKey: "test-key", model: "gemini-2.5-flash", timeoutMs: 5_000 },
      fetchImpl,
    );
    const request = makeRequest();
    request.requestId = "bad\nrequest-id";

    await assert.rejects(() => reasoner.reason(request, makeContext()), /visible ASCII characters/);
    assert.equal(called, false);
  });
});
