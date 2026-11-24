import assert from "node:assert/strict";
import { describe, it } from "node:test";

import { createReminderArgumentsSchema } from "../src/actions/taskReminderTools.js";
import { classifyVoiceDictation, describeVoiceDictation } from "../src/voice/voiceDictation.js";
import { AbsentHardwareProvider } from "../src/voice/voiceHardware.js";
import { splitSpokenReminderDue } from "../src/voice/voiceReminderDue.js";
import { VoiceSession } from "../src/voice/voiceSession.js";

// Sunday 15 November 2026, 10:00 in Melbourne (AEDT, UTC+11).
const NOW = Date.parse("2026-11-14T23:00:00.000Z");
const TZ = "Australia/Melbourne";
const CTX = { now: NOW, timezone: TZ };

function capture(utterance: string) {
  const result = classifyVoiceDictation(utterance, "client", CTX);
  assert.equal(result.status, "captured", utterance);
  assert.ok(result.status === "captured");
  return result.dictation;
}

describe("spoken reminder due times", () => {
  it("resolves day + time in either order, and a leading due phrase", () => {
    const monday7am = Date.parse("2026-11-15T20:00:00.000Z"); // Mon 16 Nov 07:00 local
    for (const utterance of [
      "remind me to call dave tomorrow at 7 am",
      "remind me to call dave at 7 am tomorrow",
      "remind me to call dave tomorrow at 7 a.m",
      "remind me to call dave tomorrow at 7am",
      "remind me tomorrow at 7 am to call dave",
      "set a reminder to call dave tomorrow at 7:00 am",
    ]) {
      const dictation = capture(utterance);
      assert.equal(dictation.command.id, "client.follow-up-reminder", utterance);
      assert.equal(dictation.capture.title, "Call dave", utterance);
      assert.equal(dictation.capture.dueAt, monday7am, utterance);
      assert.equal(dictation.capture.dueTimezone, TZ, utterance);
      assert.match(dictation.capture.dueRaw ?? "", /tomorrow/, utterance);
    }
  });

  it("resolves weekdays, tonight, noon and a bare time to the next occurrence", () => {
    const cases: Array<[string, string, string]> = [
      ["remind me to pay the rego on friday at 9 am", "Pay the rego", "2026-11-19T22:00:00.000Z"],
      ["remind me to call dave saturday at 9 am", "Call dave", "2026-11-20T22:00:00.000Z"],
      [
        "remind me to put the bins out tonight at 8",
        "Put the bins out",
        "2026-11-15T09:00:00.000Z",
      ],
      [
        "remind me to meet at the yard tomorrow at noon",
        "Meet at the yard",
        "2026-11-16T01:00:00.000Z",
      ],
      // 3:30 pm today is still ahead; 9 am today has passed, so tomorrow.
      ["remind me at 3:30 pm to ring the bank", "Ring the bank", "2026-11-15T04:30:00.000Z"],
      ["remind me to feed the dog at 9 am", "Feed the dog", "2026-11-15T22:00:00.000Z"],
      ["remind me to lock up at 19:30", "Lock up", "2026-11-15T08:30:00.000Z"],
      // Today is Sunday and 9 am has passed: "sunday" means next week.
      ["remind me to mow on sunday at 9 am", "Mow", "2026-11-21T22:00:00.000Z"],
    ];
    for (const [utterance, title, iso] of cases) {
      const dictation = capture(utterance);
      assert.equal(dictation.capture.title, title, utterance);
      assert.equal(dictation.capture.dueAt, Date.parse(iso), utterance);
    }
  });

  it("keeps what was said but guesses no time for a day alone or an am/pm-ambiguous hour", () => {
    const byFriday = capture("remind me to pay the rego by friday");
    assert.deepEqual(byFriday.capture, { title: "Pay the rego", dueRaw: "by friday" });
    const atSeven = capture("remind me to check the oven at 7");
    assert.deepEqual(atSeven.capture, { title: "Check the oven", dueRaw: "at 7" });
    assert.match(describeVoiceDictation(atSeven), /no time set — say am or pm/);
    assert.match(describeVoiceDictation(byFriday), /“by friday” \(no time set\)$/);
  });

  it("never guesses noon or midnight for 'tonight at 12'", () => {
    for (const [utterance, dueRaw] of [
      ["remind me to lock up tonight at 12", "tonight at 12"],
      ["remind me to lock up tonight at 12:30", "tonight at 12:30"],
    ] as const) {
      const dictation = capture(utterance);
      assert.deepEqual(dictation.capture, { title: "Lock up", dueRaw }, utterance);
      assert.match(describeVoiceDictation(dictation), /no time set — say am or pm/, utterance);
    }
    // Explicit noon or midnight contradicts "tonight".
    for (const utterance of [
      "remind me to lock up tonight at 12 pm",
      "remind me to lock up tonight at 12 am",
      "remind me to lock up tonight at noon",
    ]) {
      assert.equal(classifyVoiceDictation(utterance, "client", CTX).status, "rejected", utterance);
    }
    // A bare evening hour is still resolved.
    assert.equal(
      capture("remind me to lock up tonight at 11:30").capture.dueAt,
      Date.parse("2026-11-15T12:30:00.000Z"),
    );
  });

  it("fails closed on a past, contradictory or impossible time", () => {
    for (const utterance of [
      "remind me to feed the dog today at 9 am", // already passed
      "remind me to put the bins out tonight at 8 am", // contradiction
      "remind me to call dave at 25 pm",
      "remind me to call dave tomorrow at 7:75 am",
    ]) {
      assert.equal(classifyVoiceDictation(utterance, "client", CTX).status, "rejected", utterance);
    }
  });

  it("never resolves 'next <day>' and leaves undated reminders unchanged", () => {
    const next = capture("remind me to service the saw next friday at 9 am");
    assert.equal(next.capture.dueAt, undefined);
    assert.equal(next.capture.dueRaw, undefined);
    assert.deepEqual(capture("remind me to call dave about the fence").capture, {
      title: "Call dave about the fence",
    });
    // "remind me <x>" without a leading due phrase is still not a dictation.
    assert.equal(classifyVoiceDictation("remind me about the thing", "client", CTX).status, "none");
  });

  it("keeps the old behaviour when no clock/timezone is supplied", () => {
    const result = classifyVoiceDictation("remind me to call dave tomorrow at 7 am", "client");
    assert.ok(result.status === "captured");
    assert.equal(result.dictation.capture.title, "Call dave tomorrow at 7 am");
    assert.equal(result.dictation.capture.dueAt, undefined);
  });

  it("reads the resolved time back in the owner's timezone", () => {
    assert.equal(
      describeVoiceDictation(capture("remind me to call dave tomorrow at 7 am")),
      "Add reminder “Call dave” due Mon, 16 Nov, 7:00 am",
    );
  });

  it("only produces due values the reminder executor accepts", () => {
    for (const utterance of [
      "remind me to call dave tomorrow at 7 am",
      "remind me to pay the rego by friday",
      "remind me to check the oven at 7",
    ]) {
      const { capture: c } = capture(utterance);
      assert.ok(createReminderArgumentsSchema.safeParse(c).success, utterance);
    }
  });

  it("does not split a task, only reminders", () => {
    const result = classifyVoiceDictation("add a task: call dave tomorrow at 7 am", "client", CTX);
    assert.ok(result.status === "captured");
    assert.equal(result.dictation.capture.title, "Call dave tomorrow at 7 am");
    assert.equal(result.dictation.capture.dueAt, undefined);
  });

  it("split helper reports none when there is no due phrase", () => {
    assert.deepEqual(splitSpokenReminderDue("call dave", CTX), { status: "none" });
  });
});

describe("voice session spoken due times", () => {
  function session(): VoiceSession {
    return new VoiceSession({
      profile: "client",
      provider: new AbsentHardwareProvider(),
      interpretNaturalLanguage: true,
      timezone: TZ,
      clock: () => NOW,
    });
  }

  it("reads back and confirms exactly the resolved due time", async () => {
    const s = session();
    const first = await s.handle({
      transcript: "remind me to call dave tomorrow at 7 am",
      isFinal: true,
      wakeAuthorized: true,
      now: NOW,
    });
    assert.ok(first.decision === "awaiting-confirmation");
    assert.equal(first.capture?.dueAt, Date.parse("2026-11-15T20:00:00.000Z"));
    const confirmed = await s.handle({
      transcript: "confirm",
      isFinal: true,
      wakeAuthorized: true,
      now: NOW + 5_000,
    });
    assert.ok(confirmed.decision === "proposed");
    assert.deepEqual(confirmed.capture, first.capture);
  });

  it("is ambiguous when recogniser alternatives disagree on the time", async () => {
    const s = session();
    const out = await s.handle({
      transcript: "remind me to call dave tomorrow at 7 am",
      alternatives: ["remind me to call dave tomorrow at 8 am"],
      isFinal: true,
      wakeAuthorized: true,
      now: NOW,
    });
    assert.equal(out.decision, "ambiguous");
    assert.equal(s.pending(), undefined);
  });
});

describe("spoken relative reminder times", () => {
  it("counts in minutes, hours and days from now, before or after the title", () => {
    for (const [utterance, ms] of [
      ["remind me in 2 hours to check the oven", 2 * 3_600_000],
      ["remind me to check the oven in 2 hours", 2 * 3_600_000],
      ["remind me in an hour to check the oven", 3_600_000],
      ["remind me in half an hour to check the oven", 1_800_000],
      ["remind me in ten minutes to check the oven", 600_000],
      ["remind me to check the oven in 3 days", 3 * 86_400_000],
      ["remind me in a couple of hours to check the oven", 2 * 3_600_000],
    ] as const) {
      const dictation = capture(utterance);
      assert.equal(dictation.capture.title, "Check the oven", utterance);
      assert.equal(dictation.capture.dueAt, NOW + ms, utterance);
      assert.equal(dictation.capture.dueTimezone, TZ, utterance);
      assert.match(dictation.capture.dueRaw ?? "", /^in /, utterance);
    }
  });

  it("refuses nonsense counts rather than guessing", () => {
    assert.deepEqual(splitSpokenReminderDue("check the oven in 0 hours", CTX), {
      status: "rejected",
    });
    assert.deepEqual(splitSpokenReminderDue("check the oven in half an day", CTX), {
      status: "rejected",
    });
  });
});
