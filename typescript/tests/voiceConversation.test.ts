import assert from "node:assert/strict";
import { it } from "node:test";

import {
  NOT_DONE_REPLY,
  VoiceConversationService,
  type ConversationReasonerInput,
  type ConversationResult,
  type VoiceConversationReasoner,
} from "../src/voice/voiceConversation.js";
import { resolveVoiceConversationStatus } from "../src/voice/voiceConversationFactory.js";
import { AbsentHardwareProvider } from "../src/voice/voiceHardware.js";
import type { VoiceQueryAnswer } from "../src/voice/voiceQuery.js";
import { VoiceSession } from "../src/voice/voiceSession.js";
import { VoiceSessionRegistry } from "../src/voice/voiceSessionRegistry.js";

function session() {
  return new VoiceSession({
    profile: "client",
    provider: new AbsentHardwareProvider(),
    queries: {
      answer: async () => ({ status: "answered", answer: "No unpaid invoices." }),
    },
  });
}

it("requires explicit provider selection and a process credential without exposing it", () => {
  assert.deepEqual(resolveVoiceConversationStatus({ ANTHROPIC_API_KEY: "test-secret" }), {
    status: "not-configured",
    provider: null,
    model: null,
    reason: "Voice conversation is disabled.",
  });
  assert.equal(
    resolveVoiceConversationStatus({
      JARVIS_VOICE_CONVERSATION_PROVIDER: "other",
      ANTHROPIC_API_KEY: "test-secret",
    }).reason,
    "Unsupported JARVIS_VOICE_CONVERSATION_PROVIDER value.",
  );
  assert.equal(
    resolveVoiceConversationStatus({ JARVIS_VOICE_CONVERSATION_PROVIDER: "anthropic" }).status,
    "not-configured",
  );
  assert.equal(
    resolveVoiceConversationStatus({
      JARVIS_VOICE_CONVERSATION_PROVIDER: "anthropic",
      ANTHROPIC_AUTH_TOKEN: "test-token",
    }).status,
    "configured",
  );
  const configured = resolveVoiceConversationStatus({
    JARVIS_VOICE_CONVERSATION_PROVIDER: "anthropic",
    ANTHROPIC_API_KEY: "test-secret",
  });
  assert.deepEqual(configured, {
    status: "configured",
    provider: "anthropic",
    model: "claude-opus-5-5",
    reason: "Configured; no live provider probe has been performed.",
  });
  assert.ok(!JSON.stringify(configured).includes("test-secret"));
});

it("bounds utterances, rolling calls, replies, context and read-only query access", async () => {
  let now = 1000;
  const seen: string[][] = [];
  const reasoner: VoiceConversationReasoner = {
    reply: async (input) => {
      seen.push(input.history.map((message) => message.content));
      assert.deepEqual(await input.query("client.unpaid-invoices"), {
        status: "answered",
        answer: "No unpaid invoices.",
      });
      return { status: "answered", reply: "Model text that is never spoken." };
    },
  };
  const service = new VoiceConversationService({
    reasoner,
    clock: () => now,
    maxCallsPerHour: 2,
    maxUtteranceLength: 12,
    maxReplyLength: 20,
    historyLimit: 2,
  });
  const s = session();
  assert.deepEqual(await service.respond({ session: s, transcript: "x".repeat(13) }), {
    status: "unavailable",
    reason: "too-long",
  });
  assert.deepEqual(await service.respond({ session: s, transcript: "one" }), {
    status: "answered",
    reply: "No unpaid invoices.",
  });
  assert.deepEqual(await service.respond({ session: s, transcript: "two" }), {
    status: "answered",
    reply: "No unpaid invoices.",
  });
  assert.deepEqual(seen, [[], ["one", "No unpaid invoices."]]);
  assert.deepEqual(
    service.history(s).map((m) => m.content),
    ["two", "No unpaid invoices."],
  );
  assert.deepEqual(await service.respond({ session: s, transcript: "three" }), {
    status: "unavailable",
    reason: "rate-limited",
  });
  now += 3_600_001;
  assert.equal((await service.respond({ session: s, transcript: "three" })).status, "answered");
  service.clear(s);
  assert.deepEqual(service.history(s), []);
});

it("drops context when a voice session ends, expires or is evicted", async () => {
  let now = 100;
  let nextId = 0;
  const service = new VoiceConversationService({
    reasoner: { reply: async () => ({ status: "answered", reply: "Hello." }) },
  });
  const registry = new VoiceSessionRegistry({
    provider: new AbsentHardwareProvider(),
    clock: () => now,
    ttlMs: 10,
    maxSessions: 1,
    idFactory: () => String(++nextId),
  });
  registry.onRemove((s) => service.clear(s));
  const first = registry.create("client");
  const s1 = registry.get(first.id)!;
  await service.respond({ session: s1, transcript: "hello" });
  assert.equal(service.history(s1).length, 2);
  registry.end(first.id);
  assert.deepEqual(service.history(s1), []);
  const second = registry.create("client");
  const s2 = registry.get(second.id)!;
  await service.respond({ session: s2, transcript: "hello" });
  now += 11;
  assert.equal(registry.get(second.id), undefined);
  assert.deepEqual(service.history(s2), []);
  const third = registry.create("client");
  const s3 = registry.get(third.id)!;
  await service.respond({ session: s3, transcript: "hello" });
  registry.create("client");
  assert.deepEqual(service.history(s3), []);
});

it("clears history at TTL expiry through the sweep, with no later registry call", async () => {
  let now = 100;
  const service = new VoiceConversationService({
    reasoner: { reply: async () => ({ status: "answered", reply: "Hello." }) },
  });
  const registry = new VoiceSessionRegistry({
    provider: new AbsentHardwareProvider(),
    clock: () => now,
    ttlMs: 10,
    sweepIntervalMs: 5,
  });
  registry.onRemove((s) => service.clear(s));
  const created = registry.create("client");
  const s = registry.get(created.id)!;
  await service.respond({ session: s, transcript: "hello" });
  assert.equal(service.history(s).length, 2);
  now += 100;
  await new Promise((resolve) => setTimeout(resolve, 40));
  assert.equal(registry.size(), 0);
  assert.deepEqual(service.history(s), []);
});

it("denies queries and further model calls once the turn is no longer live", async () => {
  let live = true;
  const outcomes: unknown[] = [];
  const service = new VoiceConversationService({
    reasoner: {
      reply: async (input) => {
        live = false;
        outcomes.push(
          (await input.query("client.unpaid-invoices")).status,
          input.reserveNextCall(),
        );
        return { status: "answered", reply: "Hello." };
      },
    },
  });
  assert.deepEqual(
    await service.respond({ session: session(), transcript: "hi", live: () => live }),
    { status: "unavailable", reason: "unavailable" },
  );
  assert.deepEqual(outcomes, ["unavailable", false]);
});

it("aborts an in-flight reasoner when its session context is cleared", async () => {
  let observedSignal: AbortSignal | undefined;
  let finish!: () => void;
  const gate = new Promise<void>((resolve) => {
    finish = resolve;
  });
  const service = new VoiceConversationService({
    reasoner: {
      reply: async ({ signal }) => {
        observedSignal = signal;
        await gate;
        return { status: "answered", reply: "Too late." };
      },
    },
  });
  const s = session();
  const pending = service.respond({ session: s, transcript: "hello" });
  await Promise.resolve();
  assert.equal(observedSignal?.aborted, false);
  service.clear(s);
  assert.equal(observedSignal?.aborted, true);
  finish();
  assert.deepEqual(await pending, { status: "unavailable", reason: "unavailable" });
  assert.deepEqual(service.history(s), []);
});

/** Drives the real service end to end with a stubbed reasoner and per-command read model. */
function harness(
  model: Record<string, () => VoiceQueryAnswer> = {},
  options: { maxReplyLength?: number } = {},
) {
  const state = { reply: "", queried: [] as string[], reads: [] as string[] };
  const service = new VoiceConversationService({
    ...options,
    reasoner: {
      reply: async (input) => {
        for (const id of state.queried) await input.query(id);
        return { status: "answered", reply: state.reply };
      },
    },
  });
  const s = new VoiceSession({
    profile: "client",
    provider: new AbsentHardwareProvider(),
    queries: {
      answer: async ({ commandId }) => {
        state.reads.push(commandId);
        return (
          model[commandId]?.() ?? { status: "unavailable", reason: `${commandId} unreadable.` }
        );
      },
    },
  });
  const ask = async (reply: string, queried: string[] = []) => {
    state.reply = reply;
    state.queried = queried;
    return service.respond({ session: s, transcript: "status?" });
  };
  return { ask, state, service, s };
}

const SAFE = { status: "answered", reply: NOT_DONE_REPLY };
const UNPAID = "client.unpaid-invoices";
const SCHEDULE = "client.todays-schedule";
const ok = (answer: string) => (): VoiceQueryAnswer => ({ status: "answered", answer });
const down = (reason: string) => (): VoiceQueryAnswer => ({ status: "unavailable", reason });

it("zero queries: always the fixed reply, whatever the model wrote", async () => {
  const { ask, state } = harness({ [UNPAID]: ok("You have 3 unpaid invoices.") });
  for (const text of [
    "Hello.",
    "Hi!",
    "Which invoice do you mean?",
    "What I know is you owe one million dollars?",
    "What I know is your quote was sent?",
    "Is invoice 12 paid?",
    "The payment is complete.",
    "I sent the quote.",
    "",
  ]) {
    assert.deepEqual(await ask(text), SAFE, text);
  }
  assert.deepEqual(state.reads, [], "no read-model call was made");
});

it("one successful query: the exact answer, never the model's wording", async () => {
  let answer = "";
  const { ask } = harness({ [UNPAID]: () => ({ status: "answered", answer }) });
  for (const [authoritative, modelText] of [
    ["No jobs booked for today.", "Jobs booked for today."],
    ["You owe 3 dollars.", "You owe £3."],
    ["No unpaid invoices.", "No unpaid invoices. The payment is complete."],
    ["You have 3 unpaid invoices.", "Sure thing, Benny."],
  ] as const) {
    answer = authoritative;
    assert.deepEqual(await ask(modelText, [UNPAID]), { status: "answered", reply: authoritative });
  }
});

it("an answer exactly at the reply limit is spoken verbatim", async () => {
  const answer = `No jobs booked for today. ${"x".repeat(10)}`;
  const { ask } = harness({ [UNPAID]: ok(answer) }, { maxReplyLength: answer.length });
  assert.deepEqual(await ask("ignored", [UNPAID]), { status: "answered", reply: answer });
});

it("an answer over the reply limit is never truncated: reply-too-long", async () => {
  const answer = `No jobs booked for today. ${"x".repeat(639 - 26)}`;
  assert.equal(answer.length, 639);
  const { ask, service, s } = harness({ [SCHEDULE]: ok(answer) });
  assert.deepEqual(await ask("No jobs booked for today.", [SCHEDULE]), {
    status: "unavailable",
    reason: "reply-too-long",
  });
  assert.deepEqual(service.history(s), [], "nothing is recorded for a turn that spoke nothing");
});

it("more than one query attempt fails closed, including a repeated one", async () => {
  const { ask } = harness({ [UNPAID]: ok("No unpaid invoices."), [SCHEDULE]: ok("No jobs.") });
  const unavailable = { status: "unavailable", reason: "tool-limit" };
  assert.deepEqual(await ask("Both clear.", [UNPAID, SCHEDULE]), unavailable);
  assert.deepEqual(await ask("Both clear.", [UNPAID, UNPAID]), unavailable);
});

it("invoice answer then unavailable schedule never speaks the invoice answer", async () => {
  const { ask } = harness({
    [UNPAID]: ok("No unpaid invoices."),
    [SCHEDULE]: down("Schedule unreadable."),
  });
  assert.deepEqual(await ask("What's today's schedule?", [UNPAID, SCHEDULE]), {
    status: "unavailable",
    reason: "tool-limit",
  });
  assert.deepEqual(await ask("What's today's schedule?", [SCHEDULE, UNPAID]), {
    status: "unavailable",
    reason: "tool-limit",
  });
});

it("a lone unavailable or disallowed query is unavailable, not the fixed reply", async () => {
  const { ask } = harness({ [SCHEDULE]: down("Schedule unreadable.") });
  const unavailable = { status: "unavailable", reason: "unavailable" };
  assert.deepEqual(await ask("You have jobs.", [SCHEDULE]), unavailable);
  assert.deepEqual(await ask("Trailer is fine.", ["trailer.status"]), unavailable);
});

it("sweeps expiry only while sessions exist and disposal stops the timer", async () => {
  const realSet = globalThis.setInterval;
  const realClear = globalThis.clearInterval;
  const live = new Set<object>();
  let unref = 0;
  globalThis.setInterval = ((fn: () => void) => {
    const handle = { fn, unref: () => ((unref += 1), handle) };
    live.add(handle);
    return handle;
  }) as unknown as typeof setInterval;
  globalThis.clearInterval = ((handle: object) => void live.delete(handle)) as typeof clearInterval;
  try {
    let now = 0;
    const removed: unknown[] = [];
    const registry = new VoiceSessionRegistry({
      provider: new AbsentHardwareProvider(),
      clock: () => now,
      ttlMs: 10,
      sweepIntervalMs: 5,
    });
    registry.onRemove((x) => removed.push(x));
    assert.equal(live.size, 0, "an idle registry holds no timer");
    registry.create("client");
    assert.equal(live.size, 1);
    assert.equal(unref, 1, "timer never keeps the process alive");
    registry.create("client");
    assert.equal(live.size, 1, "one timer for many sessions");
    const [timer] = [...live] as { fn: () => void }[];
    now = 11;
    timer!.fn();
    assert.equal(removed.length, 2);
    assert.equal(registry.size(), 0);
    assert.equal(live.size, 0, "timer released once the last session expires");
    registry.create("client");
    assert.equal(live.size, 1);
    registry.dispose();
    assert.equal(live.size, 0);
    assert.equal(registry.size(), 0);
    assert.equal(removed.length, 3, "dispose notifies the removal listener");
    registry.dispose();
    assert.equal(live.size, 0);
  } finally {
    globalThis.setInterval = realSet;
    globalThis.clearInterval = realClear;
  }
});

it("two allowed queries then a reasoner provider-error is still tool-limit", async () => {
  const service = new VoiceConversationService({
    reasoner: {
      reply: async (input) => {
        await input.query(UNPAID);
        await input.query(SCHEDULE);
        return { status: "unavailable", reason: "provider-error" };
      },
    },
  });
  const s = new VoiceSession({
    profile: "client",
    provider: new AbsentHardwareProvider(),
    queries: { answer: async () => ({ status: "answered", answer: "Fine." }) },
  });
  assert.deepEqual(await service.respond({ session: s, transcript: "status?" }), {
    status: "unavailable",
    reason: "tool-limit",
  });
});

it("a disallowed trailer.status query is an attempt answered unavailable by the service", async () => {
  const seen: VoiceQueryAnswer[] = [];
  const service = new VoiceConversationService({
    reasoner: {
      reply: async (input) => {
        seen.push(await input.query("trailer.status"));
        return { status: "answered", reply: "ignored" };
      },
    },
  });
  const s = new VoiceSession({
    profile: "client",
    provider: new AbsentHardwareProvider(),
    queries: { answer: async () => ({ status: "answered", answer: "leak" }) },
  });
  assert.deepEqual(await service.respond({ session: s, transcript: "status?" }), {
    status: "unavailable",
    reason: "unavailable",
  });
  assert.deepEqual(
    seen.map((a) => a.status),
    ["unavailable"],
  );
});

it("classifies a lone malformed request provider-error and any second request tool-limit", async () => {
  let reads = 0;
  const respond = (script: (input: ConversationReasonerInput) => Promise<ConversationResult>) => {
    const s = session();
    const original = s.readOnlyQuery.bind(s);
    s.readOnlyQuery = async (id) => {
      reads += 1;
      return original(id);
    };
    return new VoiceConversationService({ reasoner: { reply: script } }).respond({
      session: s,
      transcript: "hi",
    });
  };
  assert.deepEqual(
    await respond(async (i) => {
      i.rejectMalformedRequest();
      return { status: "unavailable", reason: "provider-error" };
    }),
    { status: "unavailable", reason: "provider-error" },
  );
  assert.equal(reads, 0);
  assert.deepEqual(
    await respond(async (i) => {
      await i.query("trailer.status");
      return { status: "answered", reply: "x" };
    }),
    { status: "unavailable", reason: "unavailable" },
  );
  assert.equal(reads, 0);
  assert.deepEqual(
    await respond(async (i) => {
      i.rejectMalformedRequest();
      await i.query("client.unpaid-invoices");
      return { status: "unavailable", reason: "provider-error" };
    }),
    { status: "unavailable", reason: "tool-limit" },
  );
  assert.equal(reads, 1);
});
