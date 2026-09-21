import assert from "node:assert/strict";
import { describe, it } from "node:test";

import {
  PerplexityClient,
  PerplexityRequestError,
  resolvePerplexityConfig,
} from "../src/integrations/perplexity/perplexityClient.js";

function successfulPayload(overrides: Record<string, unknown> = {}) {
  return {
    id: "search-123",
    model: "sonar",
    choices: [
      {
        message: {
          role: "assistant",
          content: "Beez Treez is a paving and landscaping business.",
        },
      },
    ],
    citations: ["https://example.com/beez-treez"],
    ...overrides,
  };
}

describe("resolvePerplexityConfig", () => {
  it("requires a server-side API key", () => {
    assert.throws(
      () => resolvePerplexityConfig({ PERPLEXITY_MODEL: "sonar" }),
      /PERPLEXITY_API_KEY is required/,
    );
  });

  it("defaults to the sonar model", () => {
    const config = resolvePerplexityConfig({ PERPLEXITY_API_KEY: "test-key" });
    assert.equal(config.model, "sonar");
    assert.equal(config.timeoutMs, 30_000);
  });

  it("honours an overridden model and timeout", () => {
    const config = resolvePerplexityConfig({
      PERPLEXITY_API_KEY: "test-key",
      PERPLEXITY_MODEL: "sonar-pro",
      PERPLEXITY_TIMEOUT_MS: "5000",
    });
    assert.equal(config.model, "sonar-pro");
    assert.equal(config.timeoutMs, 5_000);
  });

  it("rejects an invalid timeout", () => {
    assert.throws(
      () =>
        resolvePerplexityConfig({ PERPLEXITY_API_KEY: "test-key", PERPLEXITY_TIMEOUT_MS: "abc" }),
      /PERPLEXITY_TIMEOUT_MS must be an integer/,
    );
  });
});

describe("PerplexityClient", () => {
  it("posts the query to the chat completions endpoint and returns the answer with citations", async () => {
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

    const client = new PerplexityClient(
      { apiKey: "test-key", model: "sonar", timeoutMs: 5_000 },
      fetchImpl,
    );
    const result = await client.search("Who is Beez Treez?");

    assert.equal(capturedUrl, "https://api.perplexity.ai/chat/completions");
    assert.equal(capturedInit?.method, "POST");
    const headers = capturedInit?.headers as Record<string, string>;
    assert.equal(headers.Authorization, "Bearer test-key");
    assert.equal(headers["Content-Type"], "application/json");

    const body = JSON.parse(String(capturedInit?.body)) as Record<string, unknown>;
    assert.equal(body.model, "sonar");
    assert.deepEqual(body.messages, [{ role: "user", content: "Who is Beez Treez?" }]);

    assert.equal(result.answer, "Beez Treez is a paving and landscaping business.");
    assert.deepEqual(result.citations, ["https://example.com/beez-treez"]);
  });

  it("returns an empty citations array when the response omits citations", async () => {
    const fetchImpl = (async () =>
      new Response(JSON.stringify(successfulPayload({ citations: undefined })), {
        status: 200,
        headers: { "Content-Type": "application/json" },
      })) as typeof fetch;
    const client = new PerplexityClient(
      { apiKey: "test-key", model: "sonar", timeoutMs: 5_000 },
      fetchImpl,
    );

    const result = await client.search("Any query");
    assert.deepEqual(result.citations, []);
  });

  it("rejects an empty query without making a network request", async () => {
    let called = false;
    const fetchImpl = (async () => {
      called = true;
      return new Response(JSON.stringify(successfulPayload()), { status: 200 });
    }) as typeof fetch;
    const client = new PerplexityClient(
      { apiKey: "test-key", model: "sonar", timeoutMs: 5_000 },
      fetchImpl,
    );

    await assert.rejects(() => client.search("   "), /query must not be empty/);
    assert.equal(called, false);
  });

  it("classifies rate limits as retryable without exposing the full response", async () => {
    const fetchImpl = (async () =>
      new Response(JSON.stringify({ error: { message: "Rate limit reached." } }), {
        status: 429,
        headers: { "Content-Type": "application/json" },
      })) as typeof fetch;
    const client = new PerplexityClient(
      { apiKey: "test-key", model: "sonar", timeoutMs: 5_000 },
      fetchImpl,
    );

    await assert.rejects(
      () => client.search("Any query"),
      (error: unknown) =>
        error instanceof PerplexityRequestError && error.status === 429 && error.retryable,
    );
  });

  it("classifies authentication failures as non-retryable", async () => {
    const fetchImpl = (async () =>
      new Response(JSON.stringify({ error: { message: "Invalid API key." } }), {
        status: 401,
        headers: { "Content-Type": "application/json" },
      })) as typeof fetch;
    const client = new PerplexityClient(
      { apiKey: "bad-key", model: "sonar", timeoutMs: 5_000 },
      fetchImpl,
    );

    await assert.rejects(
      () => client.search("Any query"),
      (error: unknown) =>
        error instanceof PerplexityRequestError && error.status === 401 && !error.retryable,
    );
  });

  it("throws when the response has no assistant message content", async () => {
    const fetchImpl = (async () =>
      new Response(JSON.stringify({ id: "x", model: "sonar", choices: [] }), {
        status: 200,
        headers: { "Content-Type": "application/json" },
      })) as typeof fetch;
    const client = new PerplexityClient(
      { apiKey: "test-key", model: "sonar", timeoutMs: 5_000 },
      fetchImpl,
    );

    await assert.rejects(() => client.search("Any query"), /did not contain an answer/);
  });
});
