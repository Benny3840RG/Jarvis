import assert from "node:assert/strict";
import { describe, it } from "node:test";

import { AbsentHardwareProvider, type VoiceActuationProvider } from "../src/voice/voiceHardware.js";
import type { VoiceQueryProvider } from "../src/voice/voiceQuery.js";
import { VoiceSession } from "../src/voice/voiceSession.js";

const offer = "crawler forward and turn crawler lights on";

function session(provider: VoiceActuationProvider = new AbsentHardwareProvider()) {
  return new VoiceSession({
    profile: "crawler",
    provider,
    interpretNaturalLanguage: true,
    confirmationTtlMs: 1_000,
  });
}

function profileSession(profile: "crawler" | "workshop" | "trailer" | "client") {
  return new VoiceSession({
    profile,
    provider: new AbsentHardwareProvider(),
    interpretNaturalLanguage: true,
    confirmationTtlMs: 1_000,
  });
}

async function say(s: VoiceSession, transcript: string, now: number, alternatives?: string[]) {
  return s.handle({ transcript, isFinal: true, wakeAuthorized: true, now, alternatives });
}

async function offered(s: VoiceSession) {
  const first = await say(s, offer, 0);
  assert.deepEqual(first, {
    decision: "ambiguous",
    candidates: ["crawler.forward", "crawler.lights-on"],
  });
  assert.equal(s.pending(), undefined);
}

describe("voice session — bounded clarification", () => {
  it("does not replace a spoken opposite command with an offered command", async () => {
    const cases = [
      ["trailer", "winch up and turn the trailer lights on", "lower the winch"],
      ["trailer", "winch up and turn the trailer lights on", "bring the winch down"],
      [
        "workshop",
        "start the compressor and turn the workshop lights on",
        "shut the compressor down",
      ],
      ["workshop", "start the compressor and turn the workshop lights on", "kill the compressor"],
      ["crawler", offer, "kill the lights off now"],
    ] as const;
    for (const [profile, first, reply] of cases) {
      const s = profileSession(profile);
      assert.equal((await say(s, first, 0)).decision, "ambiguous", first);
      assert.equal((await say(s, reply, 1)).decision, "unrecognized", reply);
      assert.equal(s.pending(), undefined, reply);
      assert.equal((await say(s, "confirm", 2)).decision, "confirmation-not-pending", reply);
    }
  });

  it("does not arm a report or question that names an offered command", async () => {
    for (const reply of [
      "i'll send the quote",
      "i'd send the quote",
      "did you send the quote",
      "i already sent the quote so draft a reminder",
    ]) {
      const s = profileSession("client");
      assert.equal((await say(s, "send the quote or draft the quote", 0)).decision, "ambiguous");
      assert.equal((await say(s, reply, 1)).decision, "unrecognized", reply);
      assert.equal(s.pending(), undefined, reply);
      assert.equal((await say(s, "confirm", 2)).decision, "confirmation-not-pending", reply);
    }
    const crawler = session();
    await offered(crawler);
    assert.equal((await say(crawler, "i went forward already", 1)).decision, "unrecognized");
    assert.equal(crawler.pending(), undefined);
  });

  it("rejects an alternative that proposes an opposite or reports the offered action", async () => {
    for (const alternative of ["lower the winch", "i'd winch up"]) {
      const s = profileSession("trailer");
      assert.equal(
        (await say(s, "winch up and turn the trailer lights on", 0)).decision,
        "ambiguous",
      );
      assert.notEqual(
        (await say(s, "raise the winch", 1, [alternative])).decision,
        "awaiting-confirmation",
      );
      assert.equal(s.pending(), undefined);
      assert.equal((await say(s, "confirm", 2)).decision, "confirmation-not-pending");
    }
  });

  it("lets an expired offer fall through to a fresh guarded request", async () => {
    const s = profileSession("client");
    assert.equal((await say(s, "send the quote or draft the quote", 0)).decision, "ambiguous");
    const fresh = await say(s, "can you send the quote", 5_000);
    assert.equal(fresh.decision, "awaiting-confirmation");
    assert.equal(s.pending()?.command.id, "client.send-quote");
    assert.equal((await say(s, "first", 5_001)).decision, "unrecognized");
  });

  it("does not arm a first-turn offer when ASR includes a control hypothesis", async () => {
    for (const alternative of ["confirm", "cancel"]) {
      const s = session();
      assert.equal((await say(s, offer, 0, [alternative])).decision, "ambiguous");
      assert.equal((await say(s, "first", 1)).decision, "unrecognized");
      assert.equal(s.pending(), undefined);
    }
  });
  it("resolves only an offered choice into single-use spoken confirmation", async () => {
    let actuations = 0;
    const provider: VoiceActuationProvider = {
      statusOf: () => "available",
      async actuate({ target }) {
        actuations += 1;
        return { status: "actuated", target };
      },
    };
    const s = session(provider);
    await offered(s);

    const choice = await say(s, "the second one", 1);
    assert.equal(choice.decision, "awaiting-confirmation");
    if (choice.decision === "awaiting-confirmation") {
      assert.equal(choice.command.id, "crawler.lights-on");
      assert.equal(choice.inferred, true);
      assert.equal(choice.expiresAt, 1_001);
    }
    assert.equal(actuations, 0);
    assert.equal(s.pending()?.command.id, "crawler.lights-on");
    assert.equal((await say(s, "confirm", 2)).decision, "actuated");
    assert.equal(actuations, 1);
    assert.equal((await say(s, "confirm", 3)).decision, "confirmation-not-pending");
  });

  it("holds clarified query and proposal behind confirmation too", async () => {
    let answers = 0;
    const queries: VoiceQueryProvider = {
      async answer() {
        answers += 1;
        return { status: "answered", answer: "Two jobs today." };
      },
    };
    const query = new VoiceSession({
      profile: "client",
      provider: new AbsentHardwareProvider(),
      queries,
      interpretNaturalLanguage: true,
    });
    assert.equal(
      (await say(query, "what is on today or any unpaid invoices", 0)).decision,
      "ambiguous",
    );
    const chosenQuery = await say(query, "first", 1);
    assert.equal(chosenQuery.decision, "awaiting-confirmation");
    assert.equal(answers, 0);
    assert.equal((await say(query, "confirm", 2)).decision, "answered");
    assert.equal(answers, 1);

    const proposal = new VoiceSession({
      profile: "client",
      provider: new AbsentHardwareProvider(),
      interpretNaturalLanguage: true,
    });
    assert.equal(
      (await say(proposal, "send the quote or draft the quote", 0)).decision,
      "ambiguous",
    );
    const chosenProposal = await say(proposal, "send it", 1);
    assert.equal(chosenProposal.decision, "awaiting-confirmation");
    assert.equal(proposal.pending()?.command.id, "client.send-quote");
    assert.equal((await say(proposal, "confirm", 2)).decision, "proposed");
  });

  it("consumes an unrelated follow-up so a later ordinal cannot act", async () => {
    const s = session();
    await offered(s);
    assert.equal((await say(s, "what is the weather", 1)).decision, "unrecognized");
    assert.equal((await say(s, "the first one", 2)).decision, "unrecognized");
    assert.equal(s.pending(), undefined);
  });

  it("drops ambiguous and empty final follow-ups", async () => {
    for (const reply of ["first or second", " "]) {
      const s = session();
      await offered(s);
      const result = await say(s, reply, 1);
      assert.notEqual(result.decision, "awaiting-confirmation");
      assert.equal((await say(s, "the first one", 2)).decision, "unrecognized");
      assert.equal(s.pending(), undefined);
    }
  });

  it("does not resolve an interim reply or retain it as authority", async () => {
    const s = session();
    await offered(s);
    assert.equal(
      (await s.handle({ transcript: "first", isFinal: false, wakeAuthorized: true, now: 1 }))
        .decision,
      "ignored-interim",
    );
    assert.equal(s.pending(), undefined);
    assert.equal((await say(s, "second", 2)).decision, "awaiting-confirmation");
  });

  it("expires the offered set at the existing confirmation TTL", async () => {
    const s = session();
    await offered(s);
    assert.equal((await say(s, "the first one", 1_000)).decision, "unrecognized");
    assert.equal(s.pending(), undefined);
    assert.equal((await say(s, "second", 1_001)).decision, "unrecognized");
  });

  it("drops clarification on decline and on a control cancel", async () => {
    for (const reply of ["nah", "cancel"]) {
      const s = session();
      await offered(s);
      assert.notEqual((await say(s, reply, 1)).decision, "awaiting-confirmation");
      assert.equal((await say(s, "first", 2)).decision, "unrecognized");
      assert.equal(s.pending(), undefined);
    }
  });

  it("drops clarification on reset, profile change and manual override", async () => {
    for (const change of [
      (s: VoiceSession) => s.reset(),
      (s: VoiceSession) => s.setProfile("trailer"),
      (s: VoiceSession) => s.manualOverride(),
    ]) {
      const s = session();
      await offered(s);
      change(s);
      assert.equal((await say(s, "the first one", 1)).decision, "unrecognized");
      assert.equal(s.pending(), undefined);
    }
  });

  it("a fresh exact command replaces clarification through the existing parser", async () => {
    const s = session();
    await offered(s);
    const exact = await say(s, "crawler stop", 1);
    assert.equal(exact.decision, "awaiting-confirmation");
    assert.equal(s.pending()?.command.id, "crawler.stop");
    assert.equal((await say(s, "first", 2)).decision, "unrecognized");
    assert.equal(s.pending()?.command.id, "crawler.stop");
    assert.equal((await say(s, "confirm", 3)).decision, "actuation-unavailable");
  });

  it("a wake-failed reply cannot resolve or preserve the offer", async () => {
    const s = session();
    await offered(s);
    const failed = await s.handle({
      transcript: "first",
      isFinal: true,
      wakeAuthorized: false,
      now: 1,
    });
    assert.equal(failed.decision, "unrecognized");
    assert.equal((await say(s, "second", 2)).decision, "unrecognized");
  });

  it("a conflicting ASR hypothesis cannot choose a candidate or leave it armed", async () => {
    for (const alternative of ["second", "cancel"]) {
      const s = session();
      await offered(s);
      const result = await say(s, "first", 1, [alternative]);
      assert.notEqual(result.decision, "awaiting-confirmation");
      assert.equal((await say(s, "first", 2)).decision, "unrecognized");
      assert.equal(s.pending(), undefined);
    }
  });
});
