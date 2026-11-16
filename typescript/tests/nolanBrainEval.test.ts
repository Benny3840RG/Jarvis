import assert from "node:assert/strict";
import { describe, it } from "node:test";

import { EVAL_CASES } from "../src/eval/nolanBrain/cases.js";
import { runEvaluation } from "../src/eval/nolanBrain/harness.js";
import { createOpenAiCompatibleVoiceReasoner } from "../src/eval/nolanBrain/openAiCompatibleReasoner.js";
import { oracleReasoner, refuseAllReasoner } from "../src/eval/nolanBrain/run.js";
import type { VoiceConversationReasoner } from "../src/voice/voiceConversation.js";

describe("NOLAN brain evaluation harness", () => {
  it("the oracle passes every check, so the cases and the scoring agree", async () => {
    const { summary, verdicts } = await runEvaluation(oracleReasoner());
    assert.equal(summary.invalidCases, 0, "every utterance bypasses the fixed grammar");
    assert.equal(summary.cases, EVAL_CASES.length);
    assert.deepEqual(
      verdicts.filter((v) => !v.correct).map((v) => `${v.outcome.caseId}: ${v.note}`),
      [],
    );
    assert.equal(summary.pass, true);
  });

  it("refusing everything is safe but fails: refusals are not successful commands", async () => {
    const { summary } = await runEvaluation(refuseAllReasoner());
    assert.equal(summary.safeRefusalRate, 1);
    assert.equal(summary.unsafeProposals, 0);
    assert.ok(summary.correctIntentRate < 0.2, String(summary.correctIntentRate));
    assert.equal(summary.pass, false);
  });

  it("counts a change armed for a refused request, or the wrong kind of change, as unsafe", async () => {
    const reckless: VoiceConversationReasoner = {
      reply: async () => ({
        status: "proposed",
        proposal: { action: "remove_errand", reference: "milk" },
      }),
    };
    const { summary, verdicts } = await runEvaluation(reckless);
    assert.ok(summary.unsafeProposals > 0);
    assert.ok(
      verdicts.some((v) => v.outcome.caseId === "refuse-wipe-tasks" && v.unsafe),
      "a refused request that reached a read-back is unsafe",
    );
    assert.ok(
      verdicts.some((v) => v.outcome.caseId === "complete-errand-milk" && v.unsafe),
      "remove instead of tick off is unsafe",
    );
    assert.equal(summary.pass, false);
  });

  it("counts the right change against the wrong record as an incorrect target", async () => {
    const wrongRecord: VoiceConversationReasoner = {
      reply: async (input) =>
        input.transcript === "got the milk this morning"
          ? {
              status: "proposed",
              proposal: { action: "complete", reference: "chain oil", kind: "errand" },
            }
          : oracleReasoner().reply(input),
    };
    const { summary, verdicts } = await runEvaluation(wrongRecord);
    assert.equal(summary.incorrectTargets, 1);
    assert.equal(
      verdicts.find((v) => v.outcome.caseId === "complete-errand-milk")?.wrongTarget,
      true,
    );
    assert.equal(summary.pass, false);
  });

  it("measures repeats separately and keeps cold start out of warm latency", async () => {
    let first = true;
    const slowStart: VoiceConversationReasoner = {
      async reply(input) {
        if (first) {
          first = false;
          await new Promise((resolve) => setTimeout(resolve, 60));
        }
        return oracleReasoner().reply(input);
      },
    };
    const { summary } = await runEvaluation(slowStart, { repeats: 2 });
    assert.equal(summary.runs, EVAL_CASES.length * 2);
    assert.ok((summary.coldMs ?? 0) >= 50);
    assert.ok(summary.medianWarmMs < 50);
  });
});

describe("OpenAI-compatible (Ollama) reasoner", () => {
  type Sent = { url: string; body: Record<string, unknown> };
  function fakeFetch(responses: unknown[], sent: Sent[]) {
    return async (url: string, init: RequestInit) => {
      sent.push({ url, body: JSON.parse(String(init.body)) as Record<string, unknown> });
      const next = responses.shift();
      return { ok: true, status: 200, json: async () => next };
    };
  }
  const toolCall = (name: string, args: unknown, id = "c1") => ({
    choices: [
      {
        message: {
          content: null,
          tool_calls: [
            { id, type: "function", function: { name, arguments: JSON.stringify(args) } },
          ],
        },
      },
    ],
  });

  it("sends NOLAN's prompt and tools and returns a validated proposal", async () => {
    const sent: Sent[] = [];
    const reasoner = createOpenAiCompatibleVoiceReasoner(
      { baseUrl: "http://dell:11434/v1/", model: "qwen3:4b", timeoutMs: 1_000 },
      {
        fetch: fakeFetch(
          [toolCall("propose_change", { action: "add_errand", title: "Bar oil" })],
          sent,
        ),
      },
    );
    const result = await reasoner.reply({
      transcript: "chuck some bar oil on the shopping list",
      profile: "client",
      catalog: [],
      history: [],
      query: async () => ({ status: "unavailable", reason: "x" }),
      rejectMalformedRequest: () => undefined,
      reserveNextCall: () => true,
    });
    assert.deepEqual(result, {
      status: "proposed",
      proposal: { action: "add_errand", title: "Bar oil" },
    });
    const first = sent[0]!;
    assert.equal(first.url, "http://dell:11434/v1/chat/completions");
    assert.equal(first.body.model, "qwen3:4b");
    const tools = first.body.tools as { function: { name: string } }[];
    assert.deepEqual(
      tools.map((tool) => tool.function.name),
      ["propose_change", "voice_query"],
    );
    const messages = first.body.messages as { role: string; content: string }[];
    assert.equal(messages[0]!.role, "system");
    assert.match(messages[0]!.content, /propose_change/);
  });

  it("answers through one query round trip and flags malformed tool calls", async () => {
    const sent: Sent[] = [];
    const reasoner = createOpenAiCompatibleVoiceReasoner(
      { baseUrl: "http://dell:11434/v1", model: "m", timeoutMs: 1_000 },
      {
        fetch: fakeFetch(
          [
            toolCall("voice_query", { commandId: "client.open-errands" }),
            { choices: [{ message: { content: "Three errands." } }] },
            toolCall("propose_change", { action: "send_quote" }),
          ],
          sent,
        ),
      },
    );
    let malformed = 0;
    const queried: string[] = [];
    const input = {
      transcript: "what do I need from the shops",
      profile: "client" as const,
      catalog: [],
      history: [],
      query: async (id: string) => {
        queried.push(id);
        return { status: "answered" as const, answer: "3 open errands." };
      },
      rejectMalformedRequest: () => {
        malformed += 1;
      },
      reserveNextCall: () => true,
    };
    assert.deepEqual(await reasoner.reply(input), { status: "answered", reply: "Three errands." });
    assert.deepEqual(queried, ["client.open-errands"]);
    const toolMessage = (sent[1]!.body.messages as { role: string; content: string }[]).at(-1);
    assert.deepEqual(toolMessage?.role, "tool");
    assert.equal(toolMessage?.content, "3 open errands.");
    assert.deepEqual(await reasoner.reply(input), {
      status: "unavailable",
      reason: "provider-error",
    });
    assert.equal(malformed, 1);
  });

  it("times out instead of hanging", async () => {
    const reasoner = createOpenAiCompatibleVoiceReasoner(
      { baseUrl: "http://dell:11434/v1", model: "m", timeoutMs: 20 },
      {
        fetch: (_url, init) =>
          new Promise((_resolve, reject) => {
            init.signal?.addEventListener("abort", () =>
              reject(Object.assign(new Error("timed out"), { name: "TimeoutError" })),
            );
          }),
      },
    );
    assert.deepEqual(
      await reasoner.reply({
        transcript: "x",
        profile: "client",
        catalog: [],
        history: [],
        query: async () => ({ status: "unavailable", reason: "x" }),
        rejectMalformedRequest: () => undefined,
        reserveNextCall: () => true,
      }),
      { status: "unavailable", reason: "timeout" },
    );
  });
});
