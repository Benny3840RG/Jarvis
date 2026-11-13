import assert from "node:assert/strict";
import { describe, it } from "node:test";

import { JARVIS_INSTRUCTIONS, JARVIS_PERSONA_MARKDOWN } from "../src/mcp/persona.js";
import { splitVoiceWakeWord, voiceUtteranceForSession } from "../src/voice/voiceSafeWrite.js";

describe("NOLAN identity and guarded voice compatibility", () => {
  it("loads the approved identity and governance boundaries into the live MCP persona", () => {
    assert.match(JARVIS_INSTRUCTIONS, /You are NOLAN/);
    assert.match(JARVIS_INSTRUCTIONS, /Notoriously Opinionated, Ludicrously Advanced Nuisance/);
    assert.match(JARVIS_INSTRUCTIONS, /ToolAction\/ΩΣ gates/);
    assert.match(JARVIS_PERSONA_MARKDOWN, /NOLAN/);
  });

  it("recognizes Nolan with punctuation and keeps legacy Jarvis compatibility", () => {
    for (const input of ["Nolan, add a task", "Nolan. add a task", "Nolan? add a task", "Jarvis add a task"]) {
      assert.deepEqual(splitVoiceWakeWord(input), { heard: true, rest: "add a task" });
    }
  });

  it("rejects similarly prefixed words and unauthorised indirect transcripts", () => {
    for (const input of ["nolanx add a task", "nolander add a task", "jarvisx add a task", "I asked Nolan add a task"]) {
      assert.equal(splitVoiceWakeWord(input).heard, false);
    }
    assert.equal(voiceUtteranceForSession({ transcript: "add a task", heardTranscript: "Nolanx add a task" }).wakeAuthorized, false);
    assert.equal(voiceUtteranceForSession({ transcript: "add a task", heardTranscript: "Nolan, add a task" }).wakeAuthorized, true);
  });

  it("does not authorise a bare wake word or mismatched transcript", () => {
    assert.equal(voiceUtteranceForSession({ transcript: "Nolan" }).wakeAuthorized, false);
    assert.equal(voiceUtteranceForSession({ transcript: "add a task", heardTranscript: "Nolan, delete everything" }).wakeAuthorized, false);
  });
});
