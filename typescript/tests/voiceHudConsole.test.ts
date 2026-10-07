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
  prepareVoiceDispatch: (
    raw: string,
    isFinal: boolean,
    alternatives?: string[],
    wakeWord?: string,
  ) => { transcript: string; isFinal: boolean; alternatives: string[] } | null;
  finalVoiceRecognition: (event: unknown) => { transcript: string; alternatives: string[] } | null;
  describeVoiceDispatch: (
    dispatch: { decision: string; answer?: string; reason?: string } | null,
  ) => { label: string; tone: string };
  voiceLatencyMs: (startedAt: unknown, endedAt: unknown) => number | null;
} {
  const match = html.match(/\/\/ BEGIN voice-console[\s\S]*?\/\/ END voice-console/);
  assert.ok(match, "voice-console block not found in dashboard HTML");
  // The block ends in a line comment, so the return must start on a new line.
  const factory = new Function(
    `"use strict"; ${match[0]}\n return { normalizeVoicePhrase, voiceCapabilities, voiceWakeGate, prepareVoiceDispatch, finalVoiceRecognition, describeVoiceDispatch, voiceLatencyMs };`,
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

    it("never prepares a bare confirm or cancel for microphone dispatch", () => {
      assert.equal(logic.prepareVoiceDispatch("confirm", true), null);
      assert.equal(logic.prepareVoiceDispatch("cancel", true), null);
    });

    it("strips the wake word from the top hypothesis and every alternative", () => {
      assert.deepEqual(
        logic.prepareVoiceDispatch("Jarvis confirm", true, [
          "Jarvis confirm command",
          "Jarvis cancel",
        ]),
        {
          transcript: "confirm",
          isFinal: true,
          alternatives: ["confirm command", "cancel"],
        },
      );
    });
  });

  it("preserves final browser recognition alternatives for server arbitration", () => {
    const result = Object.assign(
      [
        { transcript: "Jarvis confirm" },
        { transcript: "Jarvis cancel" },
        { transcript: "service confirm" },
      ],
      { isFinal: true },
    );

    assert.deepEqual(logic.finalVoiceRecognition({ resultIndex: 0, results: [result] }), {
      transcript: "Jarvis confirm",
      alternatives: ["Jarvis cancel", "service confirm"],
    });
  });

  describe("dispatch description", () => {
    it("marks disconnected query providers as unavailable, never a successful answer", () => {
      const info = logic.describeVoiceDispatch({ decision: "query-unavailable" });
      assert.equal(info.tone, "warn");
      assert.match(info.label, /query unavailable.*no data provider/i);
    });

    it("speaks an authoritative answer and a named source failure as a warning", () => {
      const answered = logic.describeVoiceDispatch({
        decision: "answered",
        answer: "No unpaid invoices.",
      });
      assert.equal(answered.tone, "ok");
      assert.equal(answered.label, "No unpaid invoices.");
      const failed = logic.describeVoiceDispatch({
        decision: "query-unavailable",
        reason: "Invoice records are unavailable.",
      });
      assert.equal(failed.tone, "warn");
      assert.equal(failed.label, "Invoice records are unavailable.");
      const blank = logic.describeVoiceDispatch({ decision: "answered", answer: "  " });
      assert.equal(blank.tone, "warn");
    });

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

  it("reports measured dispatch latency without inventing a sample", () => {
    assert.equal(logic.voiceLatencyMs(10, 42.345), 32.3);
    assert.equal(logic.voiceLatencyMs(42, 10), null);
    assert.equal(logic.voiceLatencyMs("not-a-number", 10), null);
    assert.match(html, /id="voice-latency">Dispatch latency: no sample yet\./);
  });

  it("boots the voice console before the dashboard IIFE closes", () => {
    const bootstrap = html.lastIndexOf("setupVoiceConsole();");
    const dashboardClosure = html.lastIndexOf("})();");
    assert.ok(bootstrap >= 0, "voice console bootstrap call not found");
    assert.ok(
      bootstrap < dashboardClosure,
      "voice console bootstrap must remain in function scope",
    );
  });

  it("keeps the whole inline dashboard script syntactically valid", () => {
    const openingTag = "<script>";
    const closingTag = "</script>";
    const start = html.indexOf(openingTag);
    const end = html.lastIndexOf(closingTag);
    assert.ok(start >= 0 && end > start, "inline script not found");
    const script = html.slice(start + openingTag.length, end);
    assert.doesNotThrow(() => new Function(script), "inline dashboard script must parse");
  });
});
