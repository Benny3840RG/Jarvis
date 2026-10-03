import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { describe, it } from "node:test";

const html = readFileSync(new URL("../src/mcp/dashboard-v1.html", import.meta.url), "utf8");

/** Extract the voice-console inline block and expose its pure functions. */
function loadVoiceLogic(): {
  normalizeVoicePhrase: (raw: unknown) => string;
  voiceCapabilities: (view: unknown) => { recognition: boolean; synthesis: boolean };
  voiceWakeGate: (
    raw: string,
    isFinal: boolean,
    wakeWord?: string,
  ) => { status: string; transcript?: string; isFinal?: boolean };
  describeVoiceDispatch: (dispatch: { decision: string } | null) => { label: string; tone: string };
} {
  const match = html.match(/\/\/ BEGIN voice-console[\s\S]*?\/\/ END voice-console/);
  assert.ok(match, "voice-console block not found in dashboard HTML");
  // The block ends in a line comment, so the return must start on a new line.
  const factory = new Function(
    `"use strict"; ${match[0]}\n return { normalizeVoicePhrase, voiceCapabilities, voiceWakeGate, describeVoiceDispatch };`,
  );
  return factory();
}

describe("voice HUD console logic (extracted from dashboard-v1.html)", () => {
  const logic = loadVoiceLogic();

  it("normalises phrases the same way the server does", () => {
    assert.equal(logic.normalizeVoicePhrase("  Jarvis   WINCH up! "), "jarvis winch up");
  });

  it("detects speech recognition and synthesis capabilities from the window", () => {
    assert.deepEqual(
      logic.voiceCapabilities({ SpeechRecognition: function () {}, speechSynthesis: {} }),
      {
        recognition: true,
        synthesis: true,
      },
    );
    assert.deepEqual(logic.voiceCapabilities({}), { recognition: false, synthesis: false });
    assert.deepEqual(logic.voiceCapabilities({ webkitSpeechRecognition: function () {} }), {
      recognition: true,
      synthesis: false,
    });
  });

  describe("wake-word gate", () => {
    it("ignores an utterance without the wake word", () => {
      assert.equal(logic.voiceWakeGate("winch up", true).status, "idle");
    });

    it("reports awake when only the wake word is spoken", () => {
      assert.equal(logic.voiceWakeGate("Jarvis", true).status, "awake");
    });

    it("extracts the command after the wake word and preserves finality", () => {
      const gate = logic.voiceWakeGate("Jarvis winch up.", true);
      assert.equal(gate.status, "command");
      assert.equal(gate.transcript, "winch up");
      assert.equal(gate.isFinal, true);
    });

    it("does not treat a word merely containing the wake word as awake", () => {
      assert.equal(logic.voiceWakeGate("jarvisland tour", true).status, "idle");
    });
  });

  describe("dispatch description", () => {
    it("marks unavailable actuation as a warning, never success", () => {
      const info = logic.describeVoiceDispatch({ decision: "actuation-unavailable" });
      assert.equal(info.tone, "warn");
      assert.match(info.label, /unavailable|failed closed/i);
    });

    it("shows a pending tone while awaiting confirmation", () => {
      assert.equal(
        logic.describeVoiceDispatch({ decision: "awaiting-confirmation" }).tone,
        "pending",
      );
    });

    it("describes a governed propose as proposed, not approved", () => {
      const info = logic.describeVoiceDispatch({ decision: "proposed" });
      assert.match(info.label, /propos/i);
      assert.doesNotMatch(info.label, /approved|executed/i);
    });

    it("falls back safely for an unknown decision", () => {
      assert.equal(logic.describeVoiceDispatch({ decision: "nonsense" }).tone, "muted");
    });
  });

  it("keeps the whole inline dashboard script syntactically valid", () => {
    const script = html.match(/<script>([\s\S]*)<\/script>/);
    assert.ok(script, "inline script not found");
    assert.doesNotThrow(() => new Function(script[1]), "inline dashboard script must parse");
  });
});
