import assert from "node:assert/strict";
import { describe, it } from "node:test";

import { propagation, trace } from "@opentelemetry/api";

import { createAnthropicDecider } from "../src/acp/nolanAnthropicDecider.js";

const CONFIG = { apiKey: "sdk-compatibility-test-key", model: "test-model", timeoutMs: 1_000 };
const REQUEST = { requestId: "sdk-compatibility", action: "test:read", detail: "private request" };

// Exercise the installed SDK and Zod helper, rather than the decider's fake-client seam.
// The fetch replacement is the entire transport: no credential or live model is used.
describe("Anthropic SDK compatibility", { concurrency: false }, () => {
  it("parses a structured decision using the real SDK without a tracer provider", async (t) => {
    const calls: Array<{ url: string; headers: Headers; body: Record<string, unknown> }> = [];
    t.mock.method(
      globalThis,
      "fetch",
      async (input: string | URL | Request, init?: RequestInit) => {
        calls.push({
          url: String(input),
          headers: new Headers(init?.headers),
          body: JSON.parse(String(init?.body)) as Record<string, unknown>,
        });
        return Response.json({
          id: "msg_test",
          type: "message",
          role: "assistant",
          model: CONFIG.model,
          content: [
            { type: "text", text: JSON.stringify({ decision: "deny", reason: "bounded" }) },
          ],
          stop_reason: "end_turn",
          stop_sequence: null,
          usage: { input_tokens: 1, output_tokens: 1 },
        });
      },
    );
    assert.equal(await createAnthropicDecider(CONFIG)(REQUEST), "deny");
    assert.equal(calls.length, 1);
    assert.equal(calls[0]?.url, "https://api.anthropic.com/v1/messages");
    // @anthropic-ai/sdk v1 sends the API key as `Authorization: Bearer <key>`
    // rather than the legacy `x-api-key` header (see client.apiKeyAuth()).
    assert.equal(calls[0]?.headers.get("authorization"), `Bearer ${CONFIG.apiKey}`);
    assert.equal(calls[0]?.headers.has("x-api-key"), false);
    assert.equal(calls[0]?.headers.has("traceparent"), false);
    assert.equal(calls[0]?.body.model, CONFIG.model);
    const output = calls[0]?.body.output_config as { format: { type: string } };
    assert.equal(output.format.type, "json_schema");
  });

  it("remains fail-closed when the real SDK receives malformed structured output", async (t) => {
    t.mock.method(globalThis, "fetch", async () =>
      Response.json({
        id: "msg_test",
        type: "message",
        role: "assistant",
        model: CONFIG.model,
        content: [{ type: "text", text: "not JSON" }],
        stop_reason: "end_turn",
        stop_sequence: null,
        usage: { input_tokens: 1, output_tokens: 1 },
      }),
    );
    await assert.rejects(async () => createAnthropicDecider(CONFIG)(REQUEST));
  });

  it("uses a registered provider and propagator without inventing an exporter", async (t) => {
    const spanNames: string[] = [];
    const headers: Headers[] = [];
    t.after(() => {
      trace.disable();
      propagation.disable();
    });
    assert.equal(
      trace.setGlobalTracerProvider({
        getTracer: () => ({
          startSpan(name) {
            spanNames.push(name);
            return trace.wrapSpanContext({
              traceId: "11111111111111111111111111111111",
              spanId: "2222222222222222",
              traceFlags: 1,
            });
          },
          startActiveSpan() {
            throw new Error("Unexpected startActiveSpan call");
          },
        }),
      }),
      true,
    );
    assert.equal(
      propagation.setGlobalPropagator({
        inject(_context, carrier, setter) {
          setter.set(
            carrier,
            "traceparent",
            "00-11111111111111111111111111111111-2222222222222222-01",
          );
        },
        extract(context) {
          return context;
        },
        fields: () => ["traceparent"],
      }),
      true,
    );
    t.mock.method(globalThis, "fetch", async (_input: unknown, init?: RequestInit) => {
      headers.push(new Headers(init?.headers));
      return Response.json({
        id: "msg_test",
        type: "message",
        role: "assistant",
        model: CONFIG.model,
        content: [
          { type: "text", text: JSON.stringify({ decision: "abstain", reason: "bounded" }) },
        ],
        stop_reason: "end_turn",
        stop_sequence: null,
        usage: { input_tokens: 1, output_tokens: 1 },
      });
    });
    assert.equal(await createAnthropicDecider(CONFIG)(REQUEST), "abstain");
    assert.ok(spanNames.length > 0);
    assert.equal(headers.length, 1);
    assert.equal(
      headers[0]?.get("traceparent"),
      "00-11111111111111111111111111111111-2222222222222222-01",
    );
  });
});
