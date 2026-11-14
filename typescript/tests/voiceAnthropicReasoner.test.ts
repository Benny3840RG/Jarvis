import assert from "node:assert/strict";
import { it } from "node:test";

import Anthropic from "@anthropic-ai/sdk";

import {
  createAnthropicVoiceReasoner,
  type AnthropicVoiceMessages,
} from "../src/voice/voiceAnthropicReasoner.js";
import type { ConversationReasonerInput } from "../src/voice/voiceConversation.js";
import { VOICE_COMMANDS } from "../src/voice/voiceCommands.js";

function input(overrides: Partial<ConversationReasonerInput> = {}): ConversationReasonerInput {
  return {
    transcript: "What do I owe?",
    profile: "client",
    catalog: VOICE_COMMANDS.filter((command) => command.profile === "client"),
    history: [],
    query: async () => ({ status: "answered", answer: "No unpaid invoices." }),
    reserveNextCall: () => true,
    ...overrides,
  };
}

function client(
  responses: object[],
  calls: { params: unknown; options: unknown }[],
): AnthropicVoiceMessages {
  return {
    parse: async (params, options) => {
      calls.push({ params, options });
      return responses.shift() as Awaited<ReturnType<AnthropicVoiceMessages["parse"]>>;
    },
  };
}

it("sends a bounded low-effort request with only the read-only enum tool", async () => {
  const calls: { params: unknown; options: unknown }[] = [];
  const signal = new AbortController().signal;
  const reasoner = createAnthropicVoiceReasoner(
    { apiKey: "test-only", model: "claude-opus-5-5", timeoutMs: 20_000 },
    {
      client: client(
        [{ stop_reason: "end_turn", content: [{ type: "text", text: "G'day." }] }],
        calls,
      ),
    },
  );
  assert.deepEqual(await reasoner.reply(input({ signal })), {
    status: "answered",
    reply: "G'day.",
  });
  const params = calls[0]!.params as Record<string, unknown>;
  assert.equal(params.model, "claude-opus-5-5");
  assert.equal(params.max_tokens, 2000);
  assert.deepEqual(params.output_config, { effort: "low" });
  assert.deepEqual(params.tool_choice, { type: "auto" });
  for (const key of ["temperature", "top_p", "top_k", "thinking"])
    assert.equal(key in params, false);
  assert.equal(params.fallbacks, "default");
  assert.deepEqual(params.betas, ["server-side-fallback-2026-07-01"]);
  const tools = params.tools as {
    name: string;
    input_schema: { properties: { commandId: { enum: string[] } } };
  }[];
  assert.equal(tools.length, 1);
  assert.equal(tools[0]!.name, "voice_query");
  assert.ok(tools[0]!.input_schema.properties.commandId.enum.includes("client.unpaid-invoices"));
  assert.ok(!tools[0]!.input_schema.properties.commandId.enum.includes("trailer.status"));
  assert.deepEqual(calls[0]!.options, { timeout: 20_000, signal, maxRetries: 0 });
});

it("sends the unavailable source as a tool result and never relays a guessed count", async () => {
  const calls: { params: unknown; options: unknown }[] = [];
  const tool = {
    type: "tool_use",
    id: "t1",
    name: "voice_query",
    input: { commandId: "client.unpaid-invoices" },
  };
  const reasoner = createAnthropicVoiceReasoner(
    { apiKey: "test-only", model: "claude-opus-5-5", timeoutMs: 100 },
    {
      client: client(
        [
          { stop_reason: "tool_use", content: [tool] },
          { stop_reason: "end_turn", content: [{ type: "text", text: "A guessed count." }] },
        ],
        calls,
      ),
    },
  );
  assert.deepEqual(
    await reasoner.reply(
      input({
        query: async () => ({ status: "unavailable", reason: "Invoice records are unavailable." }),
      }),
    ),
    { status: "answered", reply: "Invoice records are unavailable." },
  );
  assert.equal(calls.length, 2);
  const messages = (calls[1]!.params as { messages: { role: string; content: unknown }[] })
    .messages;
  assert.deepEqual(messages.at(-1), {
    role: "user",
    content: [
      { type: "tool_result", tool_use_id: "t1", content: "Invoice records are unavailable." },
    ],
  });
});

it("grounds a reply through the existing spoken query answer", async () => {
  const calls: { params: unknown; options: unknown }[] = [];
  const thinking = { type: "thinking", thinking: "", signature: "sig-test-only" };
  const preamble = { type: "text", text: "Checking invoices." };
  const tool = {
    type: "tool_use",
    id: "t1",
    name: "voice_query",
    input: { commandId: "client.unpaid-invoices" },
  };
  const reasoner = createAnthropicVoiceReasoner(
    { apiKey: "test-only", model: "claude-opus-5-5", timeoutMs: 100 },
    {
      client: client(
        [
          { stop_reason: "tool_use", content: [thinking, preamble, tool] },
          { stop_reason: "end_turn", content: [{ type: "text", text: "No unpaid invoices." }] },
        ],
        calls,
      ),
    },
  );
  assert.deepEqual(await reasoner.reply(input()), {
    status: "answered",
    reply: "No unpaid invoices.",
  });
  assert.equal(calls.length, 2);
  const messages = (calls[1]!.params as { messages: { role: string; content: unknown }[] })
    .messages;
  // The assistant turn is replayed exactly, thinking block and all, before the tool result.
  assert.deepEqual(messages.at(-2), { role: "assistant", content: [thinking, preamble, tool] });
  assert.deepEqual(messages.at(-1), {
    role: "user",
    content: [{ type: "tool_result", tool_use_id: "t1", content: "No unpaid invoices." }],
  });
});

it("handles refusal, truncated output, tool-loop limit, timeout and rate-limit errors", async () => {
  const config = { apiKey: "test-only", model: "claude-opus-5-5", timeoutMs: 100 };
  for (const [response, reason] of [
    [{ stop_reason: "refusal", content: [{ type: "text", text: "secret" }] }, "refused"],
    [{ stop_reason: "max_tokens", content: [] }, "provider-error"],
    [{ stop_reason: "end_turn", content: [] }, "provider-error"],
  ] as const) {
    const reasoner = createAnthropicVoiceReasoner(config, { client: client([response], []) });
    assert.deepEqual(await reasoner.reply(input()), { status: "unavailable", reason });
  }
  const tool = {
    type: "tool_use",
    id: "t1",
    name: "voice_query",
    input: { commandId: "client.unpaid-invoices" },
  };
  const loop = createAnthropicVoiceReasoner(config, {
    client: client(
      Array.from({ length: 4 }, () => ({ stop_reason: "tool_use", content: [tool] })),
      [],
    ),
  });
  assert.deepEqual(await loop.reply(input()), { status: "unavailable", reason: "tool-limit" });
  for (const [error, reason] of [
    [new Anthropic.APIConnectionTimeoutError(), "timeout"],
    [Anthropic.APIError.generate(429, {}, "rate limit", new Headers()), "rate-limited"],
    [new Error("private provider text"), "provider-error"],
  ] as const) {
    const reasoner = createAnthropicVoiceReasoner(config, {
      client: {
        parse: async () => {
          throw error;
        },
      },
    });
    assert.deepEqual(await reasoner.reply(input()), { status: "unavailable", reason });
  }
});

const toolUse = (id: string, commandId: string) => ({
  type: "tool_use",
  id,
  name: "voice_query",
  input: { commandId },
});

it("counts a second tool request after an unavailable first query (service sees both)", async () => {
  const seen: string[] = [];
  const reasoner = createAnthropicVoiceReasoner(
    { apiKey: "test-only", model: "claude-opus-5-5", timeoutMs: 20_000 },
    {
      client: client(
        [
          { stop_reason: "tool_use", content: [toolUse("a", "client.unpaid-invoices")] },
          { stop_reason: "tool_use", content: [toolUse("b", "client.todays-schedule")] },
          { stop_reason: "end_turn", content: [{ type: "text", text: "x" }] },
        ],
        [],
      ),
    },
  );
  await reasoner.reply(
    input({
      query: async (id) => {
        seen.push(id);
        return { status: "unavailable", reason: "Down." };
      },
    }),
  );
  assert.deepEqual(seen, ["client.unpaid-invoices", "client.todays-schedule"]);
});

it("forwards a disallowed voice_query id to the service instead of provider-error", async () => {
  const seen: string[] = [];
  const reasoner = createAnthropicVoiceReasoner(
    { apiKey: "test-only", model: "claude-opus-5-5", timeoutMs: 20_000 },
    {
      client: client(
        [
          { stop_reason: "tool_use", content: [toolUse("a", "trailer.status")] },
          { stop_reason: "end_turn", content: [{ type: "text", text: "x" }] },
        ],
        [],
      ),
    },
  );
  const result = await reasoner.reply(
    input({
      query: async (id) => {
        seen.push(id);
        return { status: "unavailable", reason: "Voice query unavailable." };
      },
    }),
  );
  assert.deepEqual(seen, ["trailer.status"]);
  assert.deepEqual(result, { status: "answered", reply: "Voice query unavailable." });
});
