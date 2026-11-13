import assert from "node:assert/strict";
import { it } from "node:test";

import {
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
    reply: "One sentence.",
  });
  assert.deepEqual(await service.respond({ session: s, transcript: "two" }), {
    status: "answered",
    reply: "One sentence.",
  });
  assert.deepEqual(seen, [[], ["one", "One sentence."]]);
  assert.deepEqual(
    service.history(s).map((m) => m.content),
    ["two", "One sentence."],
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
