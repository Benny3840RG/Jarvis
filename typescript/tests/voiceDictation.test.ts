import assert from "node:assert/strict";
import { describe, it } from "node:test";

import { VOICE_COMMANDS } from "../src/voice/voiceCommands.js";
import {
  classifyVoiceDictation,
  describeVoiceDictation,
  parseVoiceDictation,
} from "../src/voice/voiceDictation.js";
import { AbsentHardwareProvider } from "../src/voice/voiceHardware.js";
import { voiceUtteranceForSession } from "../src/voice/voiceSafeWrite.js";
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

describe("voice dictation unsafe titles", () => {
  const unsafe = [
    "add a task: buy oil and confirm",
    "remind me to call Dave then cancel",
    "add a task: do not order oil",
    "add a task: don't order oil",
    "add a task: never order oil",
    "add a task: I already ordered oil",
    "add a task: we ordered oil",
    "add a task: buy oil and send the quote",
    "remind me to call Dave and send the quote",
    "add a task: buy oil then email Dave",
    "add a task: buy oil, then cancel",
    "add a task: buy oil and unlock the shed",
    "add a task: buy oil and nolan stop",
    "add a task: oil, jarvis confirm",
    "add a task: buy oil\u202eX",
    "add a task: buy oil\u0000",
    "add a task: buy\u200boil",
    "remind me to call\u2066Dave",
    "remind me to call Dave\u0007",
  ];

  it("rejects embedded control, negated, declarative, compound and control-character titles", () => {
    for (const utterance of unsafe) {
      assert.equal(parseVoiceDictation(utterance, "client"), undefined, utterance);
      assert.equal(classifyVoiceDictation(utterance, "client").status, "rejected", utterance);
    }
  });

  it("rejects control whitespace inside the raw dictated text before it is normalised", () => {
    for (const utterance of [
      "add a task: buy oil\nand more",
      "add a task: buy\toil",
      "add a task: buy oil\rand more",
      "remind me to call\nDave",
      "remind me to call\tDave",
      "remind me to call Dave\rtomorrow",
      "add a work task: quote\nthe fence",
    ]) {
      assert.equal(parseVoiceDictation(utterance, "client"), undefined, JSON.stringify(utterance));
      assert.equal(
        classifyVoiceDictation(utterance, "client").status,
        "rejected",
        JSON.stringify(utterance),
      );
    }
    // Surrounding whitespace is still just whitespace; non-dictations stay none.
    assert.equal(classifyVoiceDictation("  add a task: order oil \n", "client").status, "captured");
    assert.equal(classifyVoiceDictation("what is\non today", "client").status, "none");
  });

  it("keeps ordinary natural titles working", () => {
    for (const [utterance, title] of [
      ["add a task: order bar oil", "Order bar oil"],
      ["add a task: call Dave about the quote", "Call dave about the quote"],
      ["add a work task: quote the Smith fence", "Quote the smith fence"],
      ["add a task: pay the rego", "Pay the rego"],
      ["remind me to send the invoice to Dave", "Send the invoice to dave"],
      ["remind me to renew the car insurance", "Renew the car insurance"],
      ["add a task: buy oil and grease", "Buy oil and grease"],
    ] as const) {
      assert.equal(parseVoiceDictation(utterance, "client")?.capture.title, title, utterance);
    }
  });

  it("classifies non-dictation as none", () => {
    assert.equal(classifyVoiceDictation("open tasks", "client").status, "none");
    assert.equal(classifyVoiceDictation("add a task: oil", "crawler").status, "none");
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

function turn(
  s: VoiceSession,
  transcript: string,
  now: number,
  alternatives?: readonly string[],
): ReturnType<VoiceSession["handle"]> {
  return s.handle({
    transcript,
    isFinal: true,
    wakeAuthorized: true,
    now,
    ...(alternatives ? { alternatives } : {}),
  });
}

describe("voice session conflicting hypotheses and unsafe dictation", () => {
  it("confirm with an alternative dictation of a different capture voids pending (review repro)", async () => {
    const s = session();
    const armed = await turn(s, "add a task: order oil", 1_000);
    assert.equal(armed.decision, "awaiting-confirmation");
    const out = await turn(s, "confirm", 1_100, ["add a task: order fuel"]);
    assert.equal(out.decision, "ambiguous");
    assert.equal(s.pending(), undefined);
    assert.equal((await turn(s, "confirm", 1_200)).decision, "confirmation-not-pending");
  });

  it("confirm with the same dictation, a rejected dictation, a command or cancel alternative is ambiguous", async () => {
    for (const alternative of [
      "add a task: order oil",
      "add a task: order oil and confirm",
      "remind me to order oil",
      "cancel",
      "open tasks",
    ]) {
      const s = session();
      await turn(s, "add a task: order oil", 1_000);
      const out = await turn(s, "confirm", 1_100, [alternative]);
      assert.equal(out.decision, "ambiguous", alternative);
      assert.equal(s.pending(), undefined, alternative);
    }
  });

  it("confirm with unrelated noise alternatives still proposes the pending capture", async () => {
    const s = session();
    await turn(s, "add a task: order oil", 1_000);
    const out = await turn(s, "confirm", 1_100, ["comfort", "con firm"]);
    assert.equal(out.decision, "proposed");
  });

  it("does not arm when alternatives disagree on title, category or command (review repro)", async () => {
    const cases: Array<[string, string]> = [
      ["add a task: order oil", "add a task: order fuel"],
      ["add a task: order oil", "add a work task: order oil"],
      ["remind me to call Dave", "remind me to call Dan"],
      ["add a task: order oil", "remind me to order oil"],
      ["add a task: order oil", "add a task: order oil and send the quote"],
      ["add a task: order oil", "confirm"],
      ["add a task: order oil", "cancel"],
      ["add a task: order oil", "open tasks"],
    ];
    for (const [top, alternative] of cases) {
      const s = session();
      const out = await turn(s, top, 1_000, [alternative]);
      assert.equal(out.decision, "ambiguous", `${top} | ${alternative}`);
      assert.equal(s.pending(), undefined, `${top} | ${alternative}`);
    }
  });

  it("arms when every hypothesis agrees on command and capture", async () => {
    const s = session();
    const out = await turn(s, "add a task: order oil", 1_000, [
      "Add a task order oil",
      "add a task: Order oil.",
    ]);
    assert.equal(out.decision, "awaiting-confirmation");
  });

  it("a conflicting turn invalidates an earlier pending", async () => {
    const s = session();
    await turn(s, "add a task: order oil", 1_000);
    const out = await turn(s, "remind me to call Dave", 1_100, ["remind me to call Dan"]);
    assert.equal(out.decision, "ambiguous");
    assert.equal(s.pending(), undefined);
  });

  it("an exact command with a dictation alternative is ambiguous", async () => {
    const s = session();
    const out = await turn(s, "open tasks", 1_000, ["add a task: order oil"]);
    assert.equal(out.decision, "ambiguous");
    assert.equal(s.pending(), undefined);
  });

  it("expiry and profile switch still drop a dictated capture", async () => {
    const expired = session();
    await turn(expired, "add a task: order oil", 1_000);
    assert.equal((await turn(expired, "confirm", 31_000)).decision, "confirmation-expired");
    assert.equal((await turn(expired, "confirm", 31_100)).decision, "confirmation-not-pending");

    const switched = session();
    await turn(switched, "add a task: order oil", 1_000);
    switched.setProfile("workshop");
    assert.equal(switched.pending(), undefined);
    switched.setProfile("client");
    assert.equal((await turn(switched, "confirm", 1_100)).decision, "confirmation-not-pending");
  });

  it("rejected unsafe dictations never arm, never infer, and void an earlier pending", async () => {
    const unsafe = [
      "add a task: buy oil and confirm",
      "remind me to call Dave then cancel",
      "add a task: do not order oil",
      "add a task: I already ordered oil",
      "add a task: buy oil and send the quote",
      "add a task: buy oil\u202eX",
      "add a task: buy oil\u0000",
    ];
    for (const utterance of unsafe) {
      const s = session();
      await turn(s, "remind me to call Dave", 1_000);
      const out = await turn(s, utterance, 1_100);
      assert.equal(out.decision, "unrecognized", utterance);
      assert.equal(s.pending(), undefined, utterance);
      assert.equal((await turn(s, "confirm", 1_200)).decision, "confirmation-not-pending");
      assert.equal(s.history().at(-2)?.outcome, "dictation-rejected", utterance);
    }
  });

  it("control whitespace inside a dictated title never arms, infers, or leaves pending state", async () => {
    for (const utterance of [
      "add a task: buy oil\nand more",
      "add a task: buy\toil",
      "add a task: buy oil\rand more",
      "remind me to call\nDave",
    ]) {
      const s = session();
      await turn(s, "remind me to call Dave", 1_000);
      const out = await turn(s, utterance, 1_100);
      assert.equal(out.decision, "unrecognized", JSON.stringify(utterance));
      assert.equal(s.pending(), undefined, JSON.stringify(utterance));
      assert.equal((await turn(s, "confirm", 1_200)).decision, "confirmation-not-pending");
      assert.equal(s.history().at(-2)?.outcome, "dictation-rejected", JSON.stringify(utterance));
    }
  });
});

describe("voice dictation compound action titles", () => {
  const compound = [
    "buy oil and call Dave",
    "buy oil then order fuel",
    "call Dave and book an appointment",
    "order oil and create a quote",
  ];

  it("classifier rejects chained action clauses for both task and reminder dictation", () => {
    for (const title of compound) {
      for (const prefix of ["add a task: ", "remind me to "]) {
        const utterance = prefix + title;
        assert.equal(parseVoiceDictation(utterance, "client"), undefined, utterance);
        assert.equal(classifyVoiceDictation(utterance, "client").status, "rejected", utterance);
      }
    }
  });

  it("keeps noun conjunctions and single-action titles", () => {
    for (const [utterance, title] of [
      ["add a task: buy oil and grease", "Buy oil and grease"],
      ["add a task: call Dave", "Call dave"],
      ["add a task: order bar oil", "Order bar oil"],
      ["remind me to book the van", "Book the van"],
      ["remind me to buy salt or pepper", "Buy salt or pepper"],
    ] as const) {
      const out = classifyVoiceDictation(utterance, "client");
      assert.equal(out.status, "captured", utterance);
      if (out.status === "captured") assert.equal(out.dictation.capture.title, title);
    }
  });

  it("session leaves no pending and does not infer for a rejected compound title", async () => {
    for (const title of compound) {
      const s = session();
      const out = await turn(s, `add a task: ${title}`, 1_000);
      assert.equal(out.decision, "unrecognized", title);
      assert.equal(s.pending(), undefined, title);
      assert.equal((await turn(s, "confirm", 1_100)).decision, "confirmation-not-pending");
      assert.equal(s.history().at(-2)?.outcome, "dictation-rejected", title);
    }
  });
});

describe("voice session with control characters in prepared ASR alternatives", () => {
  const cases = [
    "Nolan, add a task: order\noil",
    "add a task: order\toil",
    "Nolan, add a task: order oil\rtoday",
    "remind me to call\nDave",
    "Nolan, remind me to call\tDave",
    "remind me to call Dave\rtomorrow",
  ];

  it("an unsafe alternative stops a fresh dictation from arming", async () => {
    for (const alternative of cases) {
      const s = session();
      const prepared = voiceUtteranceForSession({
        transcript: "Nolan, add a task: order oil",
        alternatives: [alternative],
      });
      const out = await turn(s, prepared.transcript, 1_000, prepared.alternatives);
      assert.notEqual(out.decision, "awaiting-confirmation", JSON.stringify(alternative));
      assert.equal(s.pending(), undefined, JSON.stringify(alternative));
      assert.equal((await turn(s, "confirm", 1_100)).decision, "confirmation-not-pending");
    }
  });

  it("an unsafe alternative on confirm voids the pending capture", async () => {
    for (const alternative of cases) {
      const s = session();
      const armed = await turn(s, "add a task: order oil", 1_000);
      assert.equal(armed.decision, "awaiting-confirmation");
      const prepared = voiceUtteranceForSession({
        transcript: "confirm",
        alternatives: [alternative],
      });
      const out = await turn(s, prepared.transcript, 1_100, prepared.alternatives);
      assert.notEqual(out.decision, "proposed", JSON.stringify(alternative));
      assert.equal(s.pending(), undefined, JSON.stringify(alternative));
    }
  });
});
