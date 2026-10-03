import assert from "node:assert/strict";
import { describe, it } from "node:test";

import { parseUtterance } from "../src/voice/voiceParser.js";

describe("voice parser — strict whole-utterance, final-only dispatch", () => {
  it("never dispatches an interim (non-final) transcript, even an exact match", () => {
    const outcome = parseUtterance({
      transcript: "crawler stop",
      isFinal: false,
      profile: "crawler",
    });
    assert.equal(outcome.status, "pending-final");
  });

  it("recognises an exact whole utterance on a final transcript", () => {
    const outcome = parseUtterance({
      transcript: "Crawler status.",
      isFinal: true,
      profile: "crawler",
    });
    assert.equal(outcome.status, "recognized");
    if (outcome.status === "recognized") assert.equal(outcome.command.id, "crawler.status");
  });

  it("rejects a sentence that merely contains a command phrase (no substring matching)", () => {
    const outcome = parseUtterance({
      transcript: "can you tell the crawler stop please",
      isFinal: true,
      profile: "crawler",
    });
    assert.equal(outcome.status, "no-match");
  });

  it("returns no-match for an unknown final utterance", () => {
    const outcome = parseUtterance({
      transcript: "make me a coffee",
      isFinal: true,
      profile: "workshop",
    });
    assert.equal(outcome.status, "no-match");
  });

  it("treats a blank final transcript as empty, not a command", () => {
    const outcome = parseUtterance({ transcript: "   ", isFinal: true, profile: "trailer" });
    assert.equal(outcome.status, "empty");
  });

  it("does not resolve a phrase outside the active profile", () => {
    const outcome = parseUtterance({ transcript: "winch up", isFinal: true, profile: "crawler" });
    assert.equal(outcome.status, "no-match");
  });

  it("recognises when the recogniser's alternatives all agree with the top hypothesis", () => {
    const outcome = parseUtterance({
      transcript: "winch up",
      isFinal: true,
      profile: "trailer",
      alternatives: ["winch up", "winch up please"],
    });
    assert.equal(outcome.status, "recognized");
    if (outcome.status === "recognized") assert.equal(outcome.command.id, "trailer.winch-up");
  });

  it("fails closed as ambiguous when an alternative resolves to a different command", () => {
    const outcome = parseUtterance({
      transcript: "winch up",
      isFinal: true,
      profile: "trailer",
      alternatives: ["winch down"],
    });
    assert.equal(outcome.status, "ambiguous");
    if (outcome.status === "ambiguous") {
      assert.ok(outcome.candidates.includes("trailer.winch-up"));
      assert.ok(outcome.candidates.includes("trailer.winch-down"));
    }
  });

  it("never promotes a lower-confidence alternative when the top hypothesis does not match", () => {
    // Top hypothesis is noise; an alternative happens to be a real command.
    const outcome = parseUtterance({
      transcript: "winter up",
      isFinal: true,
      profile: "trailer",
      alternatives: ["winch up"],
    });
    assert.equal(outcome.status, "no-match");
  });
});
