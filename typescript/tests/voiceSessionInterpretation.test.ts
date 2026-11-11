/**
 * Natural-language interpretation wired behind the confirmation path (#567).
 *
 * The intent interpreter is advisory. Here it is wired into the live session on
 * exact no-match, and these tests prove the wiring never weakens the guarded
 * boundary:
 *   - interpretation only runs when enabled AND wake-authorised;
 *   - an inferred command is NEVER dispatched directly — it arms a single-use
 *     confirmation and waits, whatever its own criticality;
 *   - the exact parser path and the default (interpretation off) behave exactly
 *     as before.
 */

import assert from "node:assert/strict";
import { describe, it } from "node:test";

import { AbsentHardwareProvider, type VoiceActuationProvider } from "../src/voice/voiceHardware.js";
import type { VoiceQueryAnswer, VoiceQueryProvider } from "../src/voice/voiceQuery.js";
import { VoiceSession, type VoiceSessionOptions } from "../src/voice/voiceSession.js";

function make(options: Partial<VoiceSessionOptions> & { profile: VoiceSessionOptions["profile"] }) {
  return new VoiceSession({
    provider: new AbsentHardwareProvider(),
    confirmationTtlMs: 10_000,
    interpretNaturalLanguage: true,
    ...options,
  });
}

const stubQueries: VoiceQueryProvider = {
  async answer(): Promise<VoiceQueryAnswer> {
    return { status: "answered", answer: "Two jobs today." };
  },
};

describe("voice session — natural-language interpretation behind confirmation", () => {
  it("does not arm a raw wake-prefixed quote report or dispatch it on later confirm", async () => {
    const s = make({ profile: "client" });
    const transcript = "Jarvis I'd send the quote";
    const out = await s.handle({ transcript, isFinal: true, wakeAuthorized: true, now: 1 });
    assert.equal(out.decision, "unrecognized");
    assert.equal(s.pending(), undefined);
    assert.equal(s.history()[0]?.normalizedTranscript, "jarvis i'd send the quote");
    const confirmed = await s.handle({ transcript: "confirm", isFinal: true, now: 2 });
    assert.equal(confirmed.decision, "confirmation-not-pending");
  });

  it("does not infer a raw request without wake authorisation", async () => {
    const s = make({ profile: "client" });
    const out = await s.handle({
      transcript: "Jarvis, can you send the quote?",
      isFinal: true,
      wakeAuthorized: false,
      now: 1,
    });
    assert.equal(out.decision, "unrecognized");
    assert.equal(s.pending(), undefined);
  });

  it("does not dispatch after unsafe interpreted speech and a later confirm", async () => {
    let actuations = 0;
    const provider: VoiceActuationProvider = {
      statusOf: () => "available",
      async actuate(input) {
        actuations += 1;
        return { status: "actuated", target: input.target };
      },
    };
    for (const [profile, transcript, alternatives] of [
      ["crawler", "move forward and turn crawler lights on", []],
      ["workshop", "start the fan and turn workshop lights on", []],
      ["workshop", "turn the crawler's lights on", []],
      ["crawler", "turn the trailer's lights on", []],
      ["trailer", "stop the ramp", []],
      ["trailer", "raise the winch", ["I won't raise the winch"]],
      ["client", "I'll send the quote", []],
      ["trailer", "we've put the ramp down", []],
      ["trailer", "I've put the ramp down", []],
      ["trailer", "the winch can go up", []],
      ["trailer", "the winch could go up", []],
      ["trailer", "the winch may go up", []],
      ["trailer", "the winch might go up", []],
      ["trailer", "the winch would go up", []],
      ["trailer", "the winch should go up", []],
    ] as const) {
      const s = make({ profile, provider });
      const out = await s.handle({
        transcript,
        alternatives,
        isFinal: true,
        wakeAuthorized: true,
        now: 1,
      });
      assert.notEqual(out.decision, "awaiting-confirmation", transcript);
      assert.equal(s.pending(), undefined, transcript);
      const confirmed = await s.handle({ transcript: "confirm", isFinal: true, now: 2 });
      assert.equal(confirmed.decision, "confirmation-not-pending", transcript);
    }
    assert.equal(actuations, 0);
  });

  it("rejects a cancel alternative before arming an inferred actuator command", async () => {
    let actuations = 0;
    const provider: VoiceActuationProvider = {
      statusOf: () => "available",
      async actuate(input) {
        actuations += 1;
        return { status: "actuated", target: input.target };
      },
    };
    const s = make({ profile: "trailer", provider });
    const out = await s.handle({
      transcript: "raise the winch",
      alternatives: ["cancel"],
      isFinal: true,
      wakeAuthorized: true,
      now: 1,
    });
    assert.equal(out.decision, "ambiguous");
    assert.equal(s.pending(), undefined);
    const confirmed = await s.handle({ transcript: "confirm", isFinal: true, now: 2 });
    assert.equal(confirmed.decision, "confirmation-not-pending");
    assert.equal(actuations, 0);
  });

  it("does not arm out-of-profile lights, reports, or actuator questions", async () => {
    let actuations = 0;
    const provider: VoiceActuationProvider = {
      statusOf: () => "available",
      async actuate(input) {
        actuations += 1;
        return { status: "actuated", target: input.target };
      },
    };
    for (const [profile, transcript] of [
      ["workshop", "turn the trailer lights on"],
      ["trailer", "turn the workshop lights on"],
      ["trailer", "the winch went up"],
      ["trailer", "did the winch go up?"],
    ] as const) {
      const s = make({ profile, provider });
      const out = await s.handle({ transcript, isFinal: true, wakeAuthorized: true, now: 1 });
      assert.notEqual(out.decision, "awaiting-confirmation", transcript);
      assert.equal(s.pending(), undefined, transcript);
      const confirmed = await s.handle({ transcript: "confirm", isFinal: true, now: 2 });
      assert.equal(confirmed.decision, "confirmation-not-pending", transcript);
    }
    assert.equal(actuations, 0);
  });

  it("does not arm confirmation for declarative actuator states", async () => {
    for (const [transcript, profile] of [
      ["the winch is up", "trailer"],
      ["the crawler lights are on", "crawler"],
    ] as const) {
      const s = make({ profile });
      const out = await s.handle({ transcript, isFinal: true, wakeAuthorized: true, now: 1 });
      assert.notEqual(out.decision, "awaiting-confirmation", transcript);
      assert.equal(s.pending(), undefined, transcript);
      const confirm = await s.handle({ transcript: "confirm", isFinal: true, now: 2 });
      assert.notEqual(confirm.decision, "actuated", transcript);
    }
  });
  it("uses crawler context for unqualified lights but still waits for confirmation", async () => {
    const s = make({ profile: "crawler" });
    const first = await s.handle({
      transcript: "turn the lights on",
      isFinal: true,
      wakeAuthorized: true,
      now: 1,
    });
    assert.equal(first.decision, "awaiting-confirmation");
    if (first.decision === "awaiting-confirmation") {
      assert.equal(first.command.id, "crawler.lights-on");
      assert.equal(first.inferred, true);
    }
    assert.equal(s.pending()?.command.id, "crawler.lights-on");
    const confirm = await s.handle({ transcript: "confirm", isFinal: true, now: 2 });
    assert.equal(confirm.decision, "actuation-unavailable");
    assert.equal(s.pending(), undefined);
  });
  it("routes an inferred actuating command into confirmation, never actuating directly", async () => {
    let actuated = false;
    const provider: VoiceActuationProvider = {
      statusOf: () => "available",
      async actuate(input) {
        actuated = true;
        return { status: "actuated", target: input.target };
      },
    };
    const s = make({ profile: "trailer", provider });

    const first = await s.handle({
      transcript: "raise the winch",
      isFinal: true,
      wakeAuthorized: true,
      now: 1,
    });
    assert.equal(first.decision, "awaiting-confirmation");
    if (first.decision === "awaiting-confirmation") {
      assert.equal(first.command.id, "trailer.winch-up");
      assert.equal(first.inferred, true);
      assert.ok((first.confidence ?? 0) > 0);
    }
    assert.equal(actuated, false, "an inferred command must not actuate before confirmation");
    assert.ok(s.pending(), "a single-use confirmation is armed");

    const confirmed = await s.handle({ transcript: "confirm", isFinal: true, now: 2 });
    assert.equal(confirmed.decision, "actuated");
    assert.equal(actuated, true);
    assert.equal(s.pending(), undefined, "confirmation is consumed single-use");
  });

  it("answers an inferred query only after confirmation", async () => {
    const s = make({ profile: "client", queries: stubQueries });
    const first = await s.handle({
      transcript: "what's on today",
      isFinal: true,
      wakeAuthorized: true,
      now: 1,
    });
    assert.equal(first.decision, "awaiting-confirmation");
    if (first.decision === "awaiting-confirmation")
      assert.equal(first.command.id, "client.todays-schedule");

    const confirmed = await s.handle({ transcript: "confirm", isFinal: true, now: 2 });
    assert.equal(confirmed.decision, "answered");
  });

  it("stays unrecognized when the call is not wake-authorised", async () => {
    const s = make({ profile: "trailer" });
    const out = await s.handle({
      transcript: "raise the winch",
      isFinal: true,
      wakeAuthorized: false,
      now: 1,
    });
    assert.equal(out.decision, "unrecognized");
    assert.equal(s.pending(), undefined);
  });

  it("does nothing new when interpretation is disabled (default)", async () => {
    const s = new VoiceSession({ profile: "trailer", provider: new AbsentHardwareProvider() });
    const out = await s.handle({
      transcript: "raise the winch",
      isFinal: true,
      wakeAuthorized: true,
      now: 1,
    });
    assert.equal(out.decision, "unrecognized");
  });

  it("withholds on a negated request even when wake-authorised", async () => {
    const s = make({ profile: "trailer" });
    const out = await s.handle({
      transcript: "do not winch up",
      isFinal: true,
      wakeAuthorized: true,
      now: 1,
    });
    assert.equal(out.decision, "unrecognized");
  });

  it("does not interpret a command from another profile", async () => {
    const s = make({ profile: "crawler" });
    const out = await s.handle({
      transcript: "raise the winch",
      isFinal: true,
      wakeAuthorized: true,
      now: 1,
    });
    assert.equal(out.decision, "unrecognized");
  });

  it("asks for clarification on an interpreted compound utterance", async () => {
    const s = make({ profile: "crawler" });
    const out = await s.handle({
      transcript: "crawler forward and turn crawler lights on",
      isFinal: true,
      wakeAuthorized: true,
      now: 1,
    });
    assert.equal(out.decision, "ambiguous");
  });

  it("leaves the exact-match path unchanged (no inferred flag)", async () => {
    const s = make({ profile: "trailer" });
    const out = await s.handle({
      transcript: "winch up",
      isFinal: true,
      wakeAuthorized: true,
      now: 1,
    });
    assert.equal(out.decision, "awaiting-confirmation");
    if (out.decision === "awaiting-confirmation") {
      assert.equal(out.command.id, "trailer.winch-up");
      assert.equal(out.inferred, undefined, "an exact match is not flagged inferred");
    }
  });

  it("an inferred confirmation still expires (single-use TTL reused)", async () => {
    const s = make({ profile: "client", queries: stubQueries, confirmationTtlMs: 5_000 });
    await s.handle({ transcript: "what's on today", isFinal: true, wakeAuthorized: true, now: 1 });
    const expired = await s.handle({ transcript: "confirm", isFinal: true, now: 10_000 });
    assert.equal(expired.decision, "confirmation-expired");
  });
});
