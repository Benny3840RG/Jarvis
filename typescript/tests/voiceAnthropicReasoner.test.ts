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
    rejectMalformedRequest: () => {},
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

it("sends a bounded low-effort request with the read-only enum tool and, on client, propose_change", async () => {
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
  assert.deepEqual(
    tools.map((tool) => tool.name),
    ["propose_change", "voice_query"],
  );
  const query = tools[1]!;
  assert.ok(query.input_schema.properties.commandId.enum.includes("client.unpaid-invoices"));
  assert.ok(!query.input_schema.properties.commandId.enum.includes("trailer.status"));
  assert.deepEqual(calls[0]!.options, { timeout: 20_000, signal, maxRetries: 0 });
});

it("offers only the read-only query tool off the client profile", async () => {
  const calls: { params: unknown; options: unknown }[] = [];
  const reasoner = createAnthropicVoiceReasoner(
    { apiKey: "test-only", model: "claude-opus-5-5", timeoutMs: 20_000 },
    {
      client: client(
        [{ stop_reason: "end_turn", content: [{ type: "text", text: "G'day." }] }],
        calls,
      ),
    },
  );
  await reasoner.reply(
    input({
      profile: "workshop",
      catalog: VOICE_COMMANDS.filter((command) => command.profile === "workshop"),
    }),
  );
  const tools = (calls[0]!.params as { tools: { name: string }[] }).tools;
  assert.deepEqual(
    tools.map((tool) => tool.name),
    ["voice_query"],
  );
});

it("returns one validated proposal and never executes or queries for it", async () => {
  const calls: { params: unknown; options: unknown }[] = [];
  let queries = 0;
  const propose = (inputValue: unknown, extra: unknown[] = []) => ({
    stop_reason: "tool_use",
    content: [{ type: "tool_use", id: "p1", name: "propose_change", input: inputValue }, ...extra],
  });
  const run = async (response: unknown, overrides: Partial<ConversationReasonerInput> = {}) => {
    let malformed = 0;
    const result = await createAnthropicVoiceReasoner(
      { apiKey: "test-only", model: "claude-opus-5-5", timeoutMs: 100 },
      { client: client([response as never], calls) },
    ).reply(
      input({
        query: async () => {
          queries += 1;
          return { status: "answered", answer: "x" };
        },
        rejectMalformedRequest: () => {
          malformed += 1;
        },
        ...overrides,
      }),
    );
    return { result, malformed };
  };
  assert.deepEqual((await run(propose({ action: "add_errand", title: "Bar oil" }))).result, {
    status: "proposed",
    proposal: { action: "add_errand", title: "Bar oil" },
  });
  assert.deepEqual(
    (
      await run(
        propose({ action: "reschedule_reminder", reference: "bar oil", due: "friday at 9 am" }),
      )
    ).result,
    {
      status: "proposed",
      proposal: { action: "reschedule_reminder", reference: "bar oil", due: "friday at 9 am" },
    },
  );
  // Malformed: unknown action, missing fields, or extra fields.
  for (const bad of [
    { action: "send_quote", title: "Smith" },
    { action: "add_errand" },
    { action: "add_errand", title: "Milk", reference: "milk" },
    { action: "reschedule_reminder", reference: "oil" },
  ]) {
    const { result, malformed } = await run(propose(bad));
    assert.deepEqual(
      result,
      { status: "unavailable", reason: "provider-error" },
      JSON.stringify(bad),
    );
    assert.equal(malformed, 1);
  }
  // Never alongside a query in the same turn.
  assert.deepEqual(
    (
      await run(
        propose({ action: "add_errand", title: "Milk" }, [
          {
            type: "tool_use",
            id: "q1",
            name: "voice_query",
            input: { commandId: "client.open-errands" },
          },
        ]),
      )
    ).result,
    { status: "unavailable", reason: "tool-limit" },
  );
  // Never off the client profile, even if the model calls it anyway.
  assert.deepEqual(
    (
      await run(propose({ action: "add_errand", title: "Milk" }), {
        profile: "workshop",
        catalog: VOICE_COMMANDS.filter((command) => command.profile === "workshop"),
      })
    ).result,
    { status: "unavailable", reason: "tool-limit" },
  );
  assert.equal(queries, 0);
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

function malformedHarness(content: object[]) {
  const seen: string[] = [];
  let malformed = 0;
  const reasoner = createAnthropicVoiceReasoner(
    { apiKey: "test-only", model: "claude-opus-5-5", timeoutMs: 20_000 },
    {
      client: client(
        [
          { stop_reason: "tool_use", content },
          { stop_reason: "end_turn", content: [{ type: "text", text: "x" }] },
        ],
        [],
      ),
    },
  );
  const run = () =>
    reasoner.reply(
      input({
        query: async (id) => {
          seen.push(id);
          return { status: "answered", answer: "No unpaid invoices." };
        },
        rejectMalformedRequest: () => {
          malformed += 1;
        },
      }),
    );
  return { run, seen, malformed: () => malformed };
}

it("treats a wrong tool name as a counted provider-error with no read", async () => {
  const h = malformedHarness([
    { type: "tool_use", id: "a", name: "other_tool", input: { query: "client.unpaid-invoices" } },
  ]);
  assert.deepEqual(await h.run(), { status: "unavailable", reason: "provider-error" });
  assert.deepEqual(h.seen, []);
  assert.equal(h.malformed(), 1);
});

it("treats malformed voice_query input as a counted provider-error with no read", async () => {
  for (const bad of [null, [], "client.unpaid-invoices", {}, { commandId: 3 }, { query: "x" }]) {
    const h = malformedHarness([{ type: "tool_use", id: "a", name: "voice_query", input: bad }]);
    assert.deepEqual(await h.run(), { status: "unavailable", reason: "provider-error" });
    assert.deepEqual(h.seen, []);
    assert.equal(h.malformed(), 1);
  }
});

it("counts a malformed request alongside a valid one without reading the malformed one", async () => {
  const h = malformedHarness([
    { type: "tool_use", id: "a", name: "other_tool", input: {} },
    toolUse("b", "client.unpaid-invoices"),
  ]);
  await h.run();
  assert.deepEqual(h.seen, ["client.unpaid-invoices"]);
  assert.equal(h.malformed(), 1);
});
