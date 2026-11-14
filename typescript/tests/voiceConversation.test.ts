import assert from "node:assert/strict";
import { it } from "node:test";

import {
  NOT_DONE_REPLY,
  VoiceConversationService,
  spokenReply,
  type VoiceConversationReasoner,
} from "../src/voice/voiceConversation.js";
import { resolveVoiceConversationStatus } from "../src/voice/voiceConversationFactory.js";
import { AbsentHardwareProvider } from "../src/voice/voiceHardware.js";
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
      assert.equal((await input.query("trailer.status")).status, "unavailable");
      return { status: "answered", reply: "One sentence. A second sentence that is too long." };
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
  assert.equal(spokenReply("A sentence. Another one.", 13), "A sentence.");
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

/** Drives the real service end to end with a stubbed reasoner and a stubbed read model. */
function harness(answer: () => string) {
  const state = { reply: "", queries: [] as string[], queried: [] as string[] };
  const service = new VoiceConversationService({
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
        state.queries.push(commandId);
        return { status: "answered", answer: answer() };
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

it("speaks the exact authoritative answer and never the model's paraphrase", async () => {
  let answer = "";
  const { ask } = harness(() => answer);
  // Review 6873333150 probes: each model paraphrase is discarded for the exact answer.
  const probes: Array<[string, string, string]> = [
    ["No jobs booked for today.", "Jobs booked for today.", "negation reversal"],
    ["Your quote was not sent.", "Your quote was sent.", "negation reversal"],
    [
      "3 unpaid invoices, balance due 200.00. INV-001.",
      "3 unpaid invoices. They are overdue.",
      "punctuation-separated addition",
    ],
    ["You owe 3 dollars.", "You owe 3. It's in pounds.", "detached unit"],
    ["You owe 3 dollars.", "You owe 3 pounds.", "unit swap"],
    ["You owe 3 dollars.", "You owe £3.", "currency swap"],
    ["You have 3 unpaid invoices.", "You have three overdue tasks.", "entity swap"],
    ["3 invoices were sent.", "Your quote was sent.", "subject swap"],
    ["No unpaid invoices.", "No unpaid invoices. The payment is complete.", "added clause"],
  ];
  for (const [authoritative, modelText, label] of probes) {
    answer = authoritative;
    assert.deepEqual(
      await ask(modelText, [UNPAID]),
      { status: "answered", reply: authoritative },
      label,
    );
  }
  // Legitimate readbacks stay useful: model wording differences do not matter.
  answer = "You have 3 unpaid invoices.";
  assert.deepEqual(await ask("Sure thing, Benny.", [UNPAID]), {
    status: "answered",
    reply: answer,
  });
  // Several queries speak each distinct answer once, in order, still verbatim.
  answer = "No unpaid invoices.";
  assert.deepEqual(await ask("Both clear.", [UNPAID, UNPAID]), {
    status: "answered",
    reply: "No unpaid invoices.",
  });
});

it("fails closed on free-form assertions when no read-only query answered", async () => {
  const { ask, state } = harness(() => "You have 3 unpaid invoices.");
  for (const claim of [
    "The payment is complete.",
    "Your quote is on its way.",
    "Your quote has gone out.",
    "The payment went through.",
    "It has been taken care of.",
    "You have 3 unpaid invoices.",
    "You owe $999.",
    "Your next job is Tuesday at nine.",
    "Invoice 12 is overdue.",
    "I sent the quote.",
    "I've gone ahead and added that task.",
    "Hello. Your payment is complete.",
    "Hello, your quote is on its way.",
    "Which invoice? Your payment is complete.",
    "Which invoice, since your payment is complete?",
    "Which invoice and your payment is complete?",
    "Is invoice 12 paid?",
    "I haven't sent anything. Say send the quote to stage it.",
    "",
  ]) {
    assert.deepEqual(await ask(claim), SAFE, claim);
  }
  assert.deepEqual(state.queries, [], "no read-model call was made");
});

it("keeps bare greetings and single clarifying questions defined", async () => {
  const { ask } = harness(() => "No unpaid invoices.");
  for (const ok of [
    "Hello.",
    "Hi!",
    "Good morning",
    "Which one do you want to look at?",
    "Which invoice do you mean?",
    "Could you say that again?",
  ]) {
    assert.deepEqual(await ask(ok), { status: "answered", reply: ok }, ok);
  }
});

it("treats an unavailable query as no authoritative answer", async () => {
  const service = new VoiceConversationService({
    reasoner: {
      reply: async (input) => {
        await input.query(UNPAID);
        return { status: "answered", reply: "You have 3 unpaid invoices." };
      },
    },
  });
  const s = new VoiceSession({
    profile: "client",
    provider: new AbsentHardwareProvider(),
    queries: { answer: async () => ({ status: "unavailable", reason: "Invoices unreadable." }) },
  });
  assert.deepEqual(await service.respond({ session: s, transcript: "owe?" }), SAFE);
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
