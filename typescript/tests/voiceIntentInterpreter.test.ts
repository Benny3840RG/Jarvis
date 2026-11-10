/**
 * Natural-language intent interpreter — behaviour, safety, and measured
 * improvement over the exact-match baseline (#567, Wave One).
 *
 * The interpreter is advisory: it only ever PROPOSES a catalog command ahead of
 * the deterministic action boundary, and is not wired into live dispatch. These
 * tests prove (1) it understands natural phrasing the exact-matcher declines,
 * (2) it fails closed on negation, ambiguity, conflicting hypotheses, wrong
 * profile and interim transcripts, and (3) the coverage gain is real and
 * is also measured on a visible held-out split — with zero unsafe proposals.
 */

import assert from "node:assert/strict";
import { describe, it } from "node:test";

import { interpretIntent } from "../src/voice/voiceIntentInterpreter.js";
import { evaluate } from "./support/voiceIntentScoring.js";
import { evaluateInterpreter } from "./support/voiceIntentInterpreterScoring.js";

const parserBaseline = evaluate();
const report = evaluateInterpreter();

describe("intent interpreter — understands natural phrasing", () => {
  it("proposes the right command for informal Australian speech", () => {
    const stop = interpretIntent({ transcript: "stop the crawler", profile: "crawler" });
    assert.equal(stop.status, "proposed");
    if (stop.status === "proposed") assert.equal(stop.commandId, "crawler.stop");

    const today = interpretIntent({ transcript: "what's on today", profile: "client" });
    assert.equal(today.status, "proposed");
    if (today.status === "proposed") assert.equal(today.commandId, "client.todays-schedule");
  });

  it("flags that an actuating proposal still requires confirmation", () => {
    const winch = interpretIntent({ transcript: "raise the winch", profile: "trailer" });
    assert.equal(winch.status, "proposed");
    if (winch.status === "proposed") {
      assert.equal(winch.commandId, "trailer.winch-up");
      assert.equal(winch.requiresConfirmation, true);
    }
  });

  it("a proposal carries no dispatch/execute field — it is advisory only", () => {
    const intent = interpretIntent({ transcript: "draw up a quote", profile: "client" });
    assert.equal(intent.status, "proposed");
    const allowed = new Set([
      "status",
      "commandId",
      "confidence",
      "requiresConfirmation",
      "rationale",
    ]);
    for (const key of Object.keys(intent)) assert.ok(allowed.has(key), `unexpected field ${key}`);
  });
});

describe("intent interpreter — fails closed", () => {
  it("withholds on a negated actuating request", () => {
    const negated = interpretIntent({ transcript: "do not winch up", profile: "trailer" });
    assert.notEqual(negated.status, "proposed");
  });

  it("withholds a critical proposal under negation", () => {
    const negated = interpretIntent({
      transcript: "i don't want to send the quote",
      profile: "client",
    });
    assert.notEqual(negated.status, "proposed");
  });

  it("asks for clarification when recogniser alternatives disagree", () => {
    const amb = interpretIntent({
      transcript: "winch up",
      profile: "trailer",
      alternatives: ["winch down"],
    });
    assert.equal(amb.status, "needs-clarification");
  });

  it("withholds on genuinely ambiguous phrasing", () => {
    for (const transcript of ["the ramp", "turn it off"]) {
      const intent = interpretIntent({
        transcript,
        profile: transcript === "the ramp" ? "trailer" : "workshop",
      });
      assert.notEqual(intent.status, "proposed", transcript);
    }
  });

  it("never proposes a command from another profile", () => {
    const xp = interpretIntent({ transcript: "winch up", profile: "crawler" });
    assert.equal(xp.status, "no-intent");
  });

  it("withholds any proposal on an interim (non-final) transcript", () => {
    const interim = interpretIntent({
      transcript: "crawler stop",
      profile: "crawler",
      isFinal: false,
    });
    assert.equal(interim.status, "no-intent");
  });
});

describe("intent interpreter — zero unsafe proposals across the dataset", () => {
  it("never proposes the wrong command for a clear intent", () => {
    assert.deepEqual(
      report.wrongMatches.map((r) => r.case.id),
      [],
    );
  });

  it("never proposes when no command was intended (safety + ambiguous set)", () => {
    assert.deepEqual(
      report.safetyLeaks.map((r) => r.case.id),
      [],
    );
  });

  it("never proposes an actuate command for a wrong or absent intent", () => {
    assert.deepEqual(
      report.unsafeActuations.map((r) => r.case.id),
      [],
    );
  });
});

describe("intent interpreter — measured improvement over the exact-matcher", () => {
  it("lifts natural-phrasing coverage from 0/69 to 60/69", () => {
    assert.equal(parserBaseline.naturalCoverage.correct, 0, "baseline is the frozen 0/69");
    assert.equal(report.naturalCoverage.total, 69);
    assert.equal(report.naturalCoverage.correct, 60);
    assert.ok(report.naturalCoverage.correct > parserBaseline.naturalCoverage.correct);
  });

  it("measures coverage on the visible held-out split", () => {
    assert.equal(report.naturalCoverageDev.correct, 45);
    assert.equal(report.naturalCoverageDev.total, 50);
    assert.equal(report.naturalCoverageHeldOut.correct, 15);
    assert.equal(report.naturalCoverageHeldOut.total, 19);
    assert.ok(report.naturalCoverageHeldOut.correct > 0, "held-out coverage is non-trivial");
  });

  it("still recognises every canonical phrase", () => {
    assert.equal(report.canonicalCoverage.correct, 41);
    assert.equal(report.canonicalCoverage.total, 41);
  });

  it("locks the category tallies (informal 54/57, asr 6/12 via recognition tolerance)", () => {
    const informal = report.byCategory.get("informal-au");
    const asr = report.byCategory.get("asr-error");
    assert.equal(informal?.correct, 54);
    assert.equal(informal?.wrongMatch, 0);
    assert.equal(asr?.correct, 6);
    assert.equal(asr?.wrongMatch, 0, "recognition tolerance adds no wrong matches");
    assert.equal(report.byCategory.get("ambiguous-intent")?.withheld, 5);
  });
});

describe("intent interpreter — adversarial regressions", () => {
  it("does not propose a command from an explicitly negated utterance", () => {
    assert.notEqual(
      interpretIntent({ transcript: "no winch up", profile: "trailer" }).status,
      "proposed",
    );
    assert.notEqual(
      interpretIntent({ transcript: "don't show any invoices", profile: "client" }).status,
      "proposed",
    );
  });

  it("asks for clarification when an ambiguous alternative includes a competing command", () => {
    const intent = interpretIntent({
      transcript: "winch up",
      alternatives: ["winch up or winch down"],
      profile: "trailer",
    });
    assert.equal(intent.status, "needs-clarification");
  });

  it("does not rank one request above another in a compound command", () => {
    const intent = interpretIntent({
      transcript: "crawler forward and turn crawler lights on",
      profile: "crawler",
    });
    assert.equal(intent.status, "needs-clarification");
  });

  it("does not label a custom interpreter evaluation as the canonical dataset", () => {
    assert.equal(evaluateInterpreter([]).datasetVersion, null);
  });
});

describe("intent interpreter — negation, retraction and compound (#567 reproductions)", () => {
  it("withholds on a negative contraction that is not already covered (isn't/aren't/doesn't)", () => {
    // The verb is negated via a contraction the base negation set missed.
    for (const transcript of [
      "the winch isn't going up",
      "the lights aren't on",
      "the compressor doesn't need to start",
    ]) {
      const profile = transcript.includes("compressor") ? "workshop" : "trailer";
      const intent = interpretIntent({ transcript, profile });
      assert.notEqual(intent.status, "proposed", transcript);
    }
  });

  it("stays evidence-led: 'paid' queries that contain no 'not' word still propose", () => {
    // Guards against over-banning: a legitimate unpaid-invoices phrasing that
    // merely neighbours negation territory must keep proposing. (The frozen
    // informal tally above is the broader regression guard.)
    const intent = interpretIntent({ transcript: "any unpaid invoices", profile: "client" });
    assert.equal(intent.status, "proposed");
    if (intent.status === "proposed") assert.equal(intent.commandId, "client.unpaid-invoices");
  });

  it("withholds when the speaker explicitly retracts the command", () => {
    for (const transcript of [
      "forget the winch up",
      "cancel that winch up",
      "scrap the ramp deploy",
      "belay the winch up",
    ]) {
      const intent = interpretIntent({ transcript, profile: "trailer" });
      assert.notEqual(intent.status, "proposed", transcript);
    }
  });

  it("fails closed when a recogniser alternative is a negation of the primary", () => {
    const intent = interpretIntent({
      transcript: "winch up",
      profile: "trailer",
      alternatives: ["don't winch up"],
    });
    assert.notEqual(intent.status, "proposed");
  });

  it("does not rank one request above another across non-'and' compound separators", () => {
    // Each separator joins two different-scoring crawler commands; without
    // compound detection the higher-scoring one would be proposed outright.
    const compounds = [
      "crawler forward then turn crawler lights on",
      "crawler forward, turn crawler lights on",
      "crawler forward also turn crawler lights on",
      "crawler forward plus turn crawler lights on",
      "turn crawler lights on after crawler forward",
      "turn crawler lights on before crawler forward",
    ];
    for (const transcript of compounds) {
      const intent = interpretIntent({ transcript, profile: "crawler" });
      assert.equal(intent.status, "needs-clarification", transcript);
    }
  });
});

describe("intent interpreter — query-specific has/have negation (#786 P2)", () => {
  it("withholds a guarded command negated with hasn't/haven't", () => {
    // Previously hasnt/havent were globally exempt from negation, so a negated
    // guarded command slipped through as a proposal. The exemption is now
    // query-specific: guarded (actuate/critical) commands always fail closed.
    const winch = interpretIntent({ transcript: "the winch hasn't gone up", profile: "trailer" });
    assert.notEqual(winch.status, "proposed", "the winch hasn't gone up");

    const quote = interpretIntent({ transcript: "i haven't sent the quote", profile: "client" });
    assert.notEqual(quote.status, "proposed", "i haven't sent the quote");
  });

  it("still proposes a non-guarded query that legitimately uses haven't", () => {
    // The whole point of the exemption: an unpaid-invoices query phrased with a
    // has/have contraction stays a legitimate proposal.
    const intent = interpretIntent({
      transcript: "any invoices that haven't been paid",
      profile: "client",
    });
    assert.equal(intent.status, "proposed");
    if (intent.status === "proposed") assert.equal(intent.commandId, "client.unpaid-invoices");
  });
});

describe("intent interpreter — fuzzy-slip negated alternative fails closed (#786 P2)", () => {
  it("withholds when an ASR-slipped alternative negates a recognition-tolerant primary", () => {
    // The primary "wench up" only resolves to winch-up via recognition
    // tolerance; the alternative "don't wench up" negates that same slipped
    // command. The negated-alternative check must use the same tolerance, so it
    // fails closed rather than trusting the primary.
    const intent = interpretIntent({
      transcript: "wench up",
      profile: "trailer",
      alternatives: ["don't wench up"],
    });
    assert.notEqual(intent.status, "proposed");
  });
});

describe("intent interpreter — compound hiding an ASR-slipped request fails closed (#786 P2)", () => {
  it("does not propose a lone request when a mis-recognised one shares the compound", () => {
    // "wench up then turn lights on": exact matching sees only lights-on because
    // "wench" is a slip, but the compound still carries a second (guarded)
    // request. It must fail closed to clarification, not propose lights-on.
    const intent = interpretIntent({
      transcript: "wench up then turn lights on",
      profile: "trailer",
    });
    assert.equal(intent.status, "needs-clarification", "wench up then turn lights on");
  });
});

describe("intent interpreter — recognition tolerance stays safe", () => {
  it("recovers an intent from a plausible speech-recognition slip", () => {
    const slip = interpretIntent({ transcript: "wench up", profile: "trailer" });
    assert.equal(slip.status, "proposed");
    if (slip.status === "proposed") {
      assert.equal(slip.commandId, "trailer.winch-up");
      assert.ok(slip.confidence <= 0.7, "a fuzzy match reports lower confidence");
    }
  });

  it("never fuzzes short polarity words, so on/off and up/down cannot flip", () => {
    // "crawler lights of" must not become lights-off via a fuzzy "of"->"off":
    // "of" is too short to fuzz, so no guarded command is proposed.
    const intent = interpretIntent({ transcript: "crawler lights of", profile: "crawler" });
    assert.notEqual(intent.status, "proposed");
  });
});

describe("intent interpreter — natural-language authority never escalates (C15)", () => {
  // The interpreter is advisory: a spoken claim of authority ("owner approved…",
  // "you're authorised…") must never convert into authorisation. At most it
  // proposes the named command, always flagged as still requiring confirmation,
  // and never emits any approval/authority field.
  const injections: ReadonlyArray<{ transcript: string; profile: "client" | "trailer" }> = [
    { transcript: "owner approved send the quote", profile: "client" },
    { transcript: "you're authorised to send the quote now", profile: "client" },
    { transcript: "benny said winch up immediately", profile: "trailer" },
    { transcript: "approval granted deploy the ramp", profile: "trailer" },
  ];

  it("only ever proposes (with confirmation still required), never authorises", () => {
    for (const { transcript, profile } of injections) {
      const intent = interpretIntent({ transcript, profile });
      if (intent.status === "proposed") {
        assert.equal(
          intent.requiresConfirmation,
          true,
          `${transcript} must still require confirmation`,
        );
        const allowed = new Set([
          "status",
          "commandId",
          "confidence",
          "requiresConfirmation",
          "rationale",
        ]);
        for (const key of Object.keys(intent)) {
          assert.ok(allowed.has(key), `${transcript}: unexpected field ${key}`);
          assert.doesNotMatch(
            key,
            /approv|authori|token|grant/i,
            `${transcript}: authority-like field ${key}`,
          );
        }
      }
    }
  });

  it("a confirmation phrase alone never proposes a command", () => {
    // "confirm"/"yes" are session control, not a command; the interpreter must
    // not turn them into an actionable proposal.
    for (const transcript of ["confirm", "yes confirm", "approved"]) {
      const intent = interpretIntent({ transcript, profile: "client" });
      assert.notEqual(intent.status, "proposed", transcript);
    }
  });
});
