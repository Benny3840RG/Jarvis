import assert from "node:assert/strict";
import { describe, it } from "node:test";

import { JARVIS_INSTRUCTIONS, JARVIS_PERSONA_MARKDOWN } from "../src/mcp/persona.js";
import { classifyVoiceDictation } from "../src/voice/voiceDictation.js";
import { splitVoiceWakeWord, voiceUtteranceForSession } from "../src/voice/voiceSafeWrite.js";

describe("NOLAN identity and guarded voice compatibility", () => {
  it("loads the approved identity and governance boundaries into the live MCP persona", () => {
    assert.match(JARVIS_INSTRUCTIONS, /You are NOLAN/);
    assert.match(JARVIS_INSTRUCTIONS, /Notoriously Opinionated, Ludicrously Advanced Nuisance/);
    assert.match(JARVIS_INSTRUCTIONS, /ToolAction\/ΩΣ gates/);
    assert.match(JARVIS_PERSONA_MARKDOWN, /NOLAN/);
  });

  it("recognizes Nolan with punctuation and keeps legacy Jarvis compatibility", () => {
    for (const input of [
      "Nolan, add a task",
      "Nolan. add a task",
      "Nolan? add a task",
      "Jarvis add a task",
    ]) {
      assert.deepEqual(splitVoiceWakeWord(input), { heard: true, rest: "add a task" });
    }
  });

  it("rejects similarly prefixed words and unauthorised indirect transcripts", () => {
    for (const input of [
      "nolanx add a task",
      "nolander add a task",
      "jarvisx add a task",
      "I asked Nolan add a task",
    ]) {
      assert.equal(splitVoiceWakeWord(input).heard, false);
    }
    assert.equal(
      voiceUtteranceForSession({ transcript: "add a task", heardTranscript: "Nolanx add a task" })
        .wakeAuthorized,
      false,
    );
    assert.equal(
      voiceUtteranceForSession({ transcript: "add a task", heardTranscript: "Nolan, add a task" })
        .wakeAuthorized,
      true,
    );
  });

  it("does not authorise a bare wake word or mismatched transcript", () => {
    assert.equal(voiceUtteranceForSession({ transcript: "Nolan" }).wakeAuthorized, false);
    assert.equal(
      voiceUtteranceForSession({
        transcript: "add a task",
        heardTranscript: "Nolan, delete everything",
      }).wakeAuthorized,
      false,
    );
  });
});

describe("HTTP safe-write preparation keeps raw control whitespace for dictation", () => {
  it("does not let newline, tab or CR be normalised away before the unsafe check", () => {
    for (const transcript of [
      "Nolan, add a task: buy oil\nand more",
      "Nolan, add a task: buy\toil",
      "Nolan, add a task: buy oil\rand more",
      "Nolan, remind me to call\nDave",
    ]) {
      const prepared = voiceUtteranceForSession({ transcript });
      assert.equal(prepared.wakeAuthorized, true);
      assert.equal(
        classifyVoiceDictation(prepared.transcript, "client").status,
        "rejected",
        JSON.stringify(transcript),
      );
    }
    const safe = voiceUtteranceForSession({ transcript: "Nolan,  add a task:   order oil \n" });
    assert.equal(classifyVoiceDictation(safe.transcript, "client").status, "captured");
    assert.equal(
      voiceUtteranceForSession({ transcript: "Nolan, what is\non today" }).transcript,
      "what is on today",
    );
  });
});

describe("HTTP preparation keeps raw control whitespace in ASR alternatives", () => {
  it("passes dictated alternatives unnormalised so they classify as rejected", () => {
    for (const alternative of [
      "Nolan, add a task: buy oil\nand more",
      "add a task: buy\toil",
      "Nolan, add a task: buy oil\rand more",
      "Nolan, remind me to call\nDave",
      "remind me to call\tDave",
      "remind me to call Dave\rtomorrow",
    ]) {
      const prepared = voiceUtteranceForSession({
        transcript: "Nolan, add a task: order oil",
        alternatives: [alternative],
      });
      const [out] = prepared.alternatives ?? [];
      assert.equal(classifyVoiceDictation(out ?? "", "client").status, "rejected", alternative);
      assert.ok(!/^nolan/i.test(out ?? ""), "wake word stripped");
    }
  });

  it("still strips wake words and normalises benign alternatives", () => {
    const prepared = voiceUtteranceForSession({
      transcript: "Nolan, what is on today",
      alternatives: ["Nolan,  add a task:   order oil \n", "what is\non today", "jarvis status"],
    });
    assert.equal(
      classifyVoiceDictation(prepared.alternatives?.[0] ?? "", "client").status,
      "captured",
    );
    assert.deepEqual(prepared.alternatives?.slice(1), ["what is on today", "status"]);
  });
});
