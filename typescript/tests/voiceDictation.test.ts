import assert from "node:assert/strict";
import { describe, it } from "node:test";

import { VOICE_COMMANDS } from "../src/voice/voiceCommands.js";
import { describeVoiceDictation, parseVoiceDictation } from "../src/voice/voiceDictation.js";
import { AbsentHardwareProvider } from "../src/voice/voiceHardware.js";
import { VoiceSession } from "../src/voice/voiceSession.js";

describe("voice dictation grammar", () => {
  it("captures a task title with the default category", () => {
    const dictation = parseVoiceDictation("add a task: order bar oil", "client");
    assert.equal(dictation?.command.id, "client.capture-task");
    assert.deepEqual(dictation?.capture, { title: "Order bar oil", category: "personal" });
  });

  it("captures a spoken category and its aliases", () => {
    const cases: Array<[string, string, string]> = [
      ["add a work task: quote the Smith fence", "Quote the smith fence", "work"],
      ["add a build task replace the crawler servo", "Replace the crawler servo", "builds"],
      ["new money task, pay the rego", "Pay the rego", "money"],
      ["capture a home task to fix the gate", "Fix the gate", "life"],
      ["add a new task call the supplier", "Call the supplier", "personal"],
      ["new task: sharpen the chains", "Sharpen the chains", "personal"],
    ];
    for (const [utterance, title, category] of cases) {
      const dictation = parseVoiceDictation(utterance, "client");
      assert.equal(dictation?.command.id, "client.capture-task", utterance);
      assert.deepEqual(dictation?.capture, { title, category }, utterance);
    }
  });

  it("captures a reminder title", () => {
    for (const utterance of [
      "remind me to call Dave about the fence",
      "set a reminder to call Dave about the fence",
      "add a reminder to call dave about the fence.",
    ]) {
      const dictation = parseVoiceDictation(utterance, "client");
      assert.equal(dictation?.command.id, "client.follow-up-reminder", utterance);
      assert.equal(dictation?.capture.title.toLowerCase(), "call dave about the fence", utterance);
      assert.equal(dictation?.capture.category, undefined, utterance);
    }
  });

  it("fails closed on anything that is not an unambiguous dictation", () => {
    const rejected = [
      "",
      "add a task",
      "add a task:",
      "add a task ...",
      "remind me to",
      "add a garbage task buy oil", // unknown category word is never guessed
      "don't add a task buy oil", // prefix is anchored
      "please add a task buy oil",
      "add a task nolan send the quote", // wake word inside the payload
      "add a task jarvis winch up",
      "add a task confirm",
      "remind me to cancel",
      "remind me to confirm the booking",
      "send the quote",
      "add an errand pick up oil", // errands have no executor
      `add a task ${"x".repeat(201)}`,
    ];
    for (const utterance of rejected) {
      assert.equal(parseVoiceDictation(utterance, "client"), undefined, utterance);
    }
  });

  it("is limited to the client profile", () => {
    for (const profile of ["crawler", "workshop", "trailer"] as const) {
      assert.equal(parseVoiceDictation("add a task: order bar oil", profile), undefined, profile);
    }
  });

  it("only ever reaches the two safe-write commands", () => {
    const ids = new Set(
      ["add a task: a", "add a work task: b", "remind me to c", "set a reminder to d"].map(
        (utterance) => parseVoiceDictation(utterance, "client")?.command.id,
      ),
    );
    assert.deepEqual([...ids].sort(), ["client.capture-task", "client.follow-up-reminder"]);
    for (const id of ids) {
      const command = VOICE_COMMANDS.find((entry) => entry.id === id);
      assert.equal(command?.kind, "propose");
      assert.equal(command?.criticality, "routine");
    }
  });

  it("reads the capture back in one line", () => {
    const task = parseVoiceDictation("add a work task: order bar oil", "client");
    const reminder = parseVoiceDictation("remind me to call Dave", "client");
    assert.ok(task && reminder);
    assert.equal(describeVoiceDictation(task), "Add task “Order bar oil” (work)");
    assert.equal(describeVoiceDictation(reminder), "Add reminder “Call dave”");
  });
});

function session(): VoiceSession {
  return new VoiceSession({
    profile: "client",
    provider: new AbsentHardwareProvider(),
    interpretNaturalLanguage: true,
    clock: () => 1_000,
  });
}

describe("voice session dictation", () => {
  it("arms a single-use read-back confirmation and proposes the dictated capture", async () => {
    const s = session();
    const first = await s.handle({
      transcript: "add a work task: order bar oil",
      isFinal: true,
      wakeAuthorized: true,
      now: 1_000,
    });
    assert.equal(first.decision, "awaiting-confirmation");
    assert.ok(first.decision === "awaiting-confirmation");
    assert.equal(first.command.id, "client.capture-task");
    assert.deepEqual(first.capture, { title: "Order bar oil", category: "work" });
    assert.equal(first.inferred, undefined);
    assert.deepEqual(s.pending()?.capture, { title: "Order bar oil", category: "work" });

    const confirmed = await s.handle({
      transcript: "confirm",
      isFinal: true,
      wakeAuthorized: true,
      now: 2_000,
    });
    assert.equal(confirmed.decision, "proposed");
    assert.ok(confirmed.decision === "proposed");
    assert.deepEqual(confirmed.capture, { title: "Order bar oil", category: "work" });
    assert.equal(s.pending(), undefined);

    const replay = await s.handle({
      transcript: "confirm",
      isFinal: true,
      wakeAuthorized: true,
      now: 2_500,
    });
    assert.equal(replay.decision, "confirmation-not-pending");
  });

  it("drops the capture on cancel, expiry and a fresh command", async () => {
    const cancelled = session();
    await cancelled.handle({
      transcript: "remind me to call Dave",
      isFinal: true,
      wakeAuthorized: true,
      now: 1_000,
    });
    assert.equal(
      (
        await cancelled.handle({
          transcript: "cancel",
          isFinal: true,
          wakeAuthorized: true,
          now: 1_100,
        })
      ).decision,
      "cancelled",
    );
    assert.equal(cancelled.pending(), undefined);

    const expired = session();
    await expired.handle({
      transcript: "remind me to call Dave",
      isFinal: true,
      wakeAuthorized: true,
      now: 1_000,
    });
    const late = await expired.handle({
      transcript: "confirm",
      isFinal: true,
      wakeAuthorized: true,
      now: 1_000 + 30_000,
    });
    assert.equal(late.decision, "confirmation-expired");

    const replaced = session();
    await replaced.handle({
      transcript: "remind me to call Dave",
      isFinal: true,
      wakeAuthorized: true,
      now: 1_000,
    });
    await replaced.handle({
      transcript: "open tasks",
      isFinal: true,
      wakeAuthorized: true,
      now: 1_100,
    });
    assert.equal(replaced.pending(), undefined);
  });

  it("never dictates without the wake word", async () => {
    const s = session();
    const out = await s.handle({
      transcript: "add a task: order bar oil",
      isFinal: true,
      now: 1_000,
    });
    assert.equal(out.decision, "unrecognized");
    assert.equal(s.pending(), undefined);
  });

  it("never dictates from interim speech", async () => {
    const s = session();
    const out = await s.handle({
      transcript: "add a task: order bar oil",
      isFinal: false,
      wakeAuthorized: true,
      now: 1_000,
    });
    assert.equal(out.decision, "ignored-interim");
    assert.equal(s.pending(), undefined);
  });

  it("is ambiguous when a recogniser alternative is a control phrase or another dictation", async () => {
    const control = session();
    const a = await control.handle({
      transcript: "add a task: order bar oil",
      alternatives: ["confirm"],
      isFinal: true,
      wakeAuthorized: true,
      now: 1_000,
    });
    assert.equal(a.decision, "ambiguous");
    assert.equal(control.pending(), undefined);

    const other = session();
    const b = await other.handle({
      transcript: "add a task: call Dave",
      alternatives: ["remind me to call Dave"],
      isFinal: true,
      wakeAuthorized: true,
      now: 1_000,
    });
    assert.equal(b.decision, "ambiguous");
    assert.ok(b.decision === "ambiguous");
    assert.deepEqual([...b.candidates], ["client.capture-task", "client.follow-up-reminder"]);
    assert.equal(other.pending(), undefined);
  });

  it("leaves exact catalog phrases on the exact path", async () => {
    const s = session();
    const out = await s.handle({
      transcript: "add a task",
      isFinal: true,
      wakeAuthorized: true,
      now: 1_000,
    });
    assert.equal(out.decision, "proposed");
    assert.ok(out.decision === "proposed");
    assert.equal(out.capture, undefined);
  });
});
