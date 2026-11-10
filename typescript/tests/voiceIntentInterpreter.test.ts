/**
 * Natural-language intent interpreter — behaviour, safety, and measured
 * improvement over the exact-match baseline (#567, Wave One).
 *
 * The interpreter is advisory: it only ever PROPOSES a catalog command ahead of
 * the deterministic action boundary, and is not wired into live dispatch. These
 * tests prove (1) it understands natural phrasing the exact-matcher declines,
 * (2) it fails closed on negation, ambiguity, conflicting hypotheses, wrong
 * profile and interim transcripts, and (3) the coverage gain is real and
 * generalises to a held-out split — with zero unsafe proposals.
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
  it("lifts natural-phrasing coverage from 0/69 to 56/69", () => {
    assert.equal(parserBaseline.naturalCoverage.correct, 0, "baseline is the frozen 0/69");
    assert.equal(report.naturalCoverage.total, 69);
    assert.equal(report.naturalCoverage.correct, 56);
    assert.ok(report.naturalCoverage.correct > parserBaseline.naturalCoverage.correct);
  });

  it("generalises to the held-out split (not overfit to the dev split)", () => {
    assert.equal(report.naturalCoverageDev.correct, 42);
    assert.equal(report.naturalCoverageDev.total, 50);
    assert.equal(report.naturalCoverageHeldOut.correct, 14);
    assert.equal(report.naturalCoverageHeldOut.total, 19);
    assert.ok(report.naturalCoverageHeldOut.correct > 0, "held-out coverage is non-trivial");
  });

  it("still recognises every canonical phrase", () => {
    assert.equal(report.canonicalCoverage.correct, 41);
    assert.equal(report.canonicalCoverage.total, 41);
  });

  it("locks the category tallies (informal 54/57, asr 2/12 — phonetic errors remain hard)", () => {
    const informal = report.byCategory.get("informal-au");
    const asr = report.byCategory.get("asr-error");
    assert.equal(informal?.correct, 54);
    assert.equal(informal?.wrongMatch, 0);
    assert.equal(asr?.correct, 2);
    assert.equal(report.byCategory.get("ambiguous-intent")?.withheld, 5);
  });
});
