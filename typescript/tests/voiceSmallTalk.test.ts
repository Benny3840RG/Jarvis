import assert from "node:assert/strict";
import { describe, it } from "node:test";

import { VOICE_HELP_REPLY, smallTalkReply } from "../src/voice/voiceSmallTalk.js";

describe("voice small talk", () => {
  it("answers thanks, greetings and sign-offs with a fixed friendly reply", () => {
    assert.equal(smallTalkReply("thanks mate"), "No worries.");
    assert.equal(smallTalkReply("Cheers!"), "No worries.");
    assert.equal(smallTalkReply("thanks, Nolan"), "No worries.");
    assert.equal(smallTalkReply("G'day"), "G'day. What can I do for you?");
    assert.equal(smallTalkReply("how ya going"), "G'day. What can I do for you?");
    assert.equal(smallTalkReply("that's all thanks"), "No worries. Catch you later.");
  });

  it("only matches whole phrases, never a request that happens to start politely", () => {
    for (const phrase of [
      "thanks, add milk to the list",
      "hey turn the lights off",
      "cheers send the quote",
      "",
    ]) {
      assert.equal(smallTalkReply(phrase), undefined, phrase);
    }
  });
});

describe("voice clock and help", () => {
  // Wednesday 25 November 2026, 3:05 pm in Melbourne (AEDT, UTC+11).
  const clock = { now: Date.parse("2026-11-25T04:05:00.000Z"), timezone: "Australia/Melbourne" };

  it("tells the time and the date from the server clock", () => {
    assert.equal(smallTalkReply("what time is it", clock), "It's 3:05 pm.");
    assert.equal(smallTalkReply("what's the time?", clock), "It's 3:05 pm.");
    assert.equal(smallTalkReply("what day is it", clock), "It's Wednesday 25 November.");
    assert.equal(smallTalkReply("what time is it"), undefined, "no clock, no answer");
  });

  it("explains what NOLAN can do", () => {
    assert.equal(smallTalkReply("what can you do"), VOICE_HELP_REPLY);
    assert.equal(smallTalkReply("help"), VOICE_HELP_REPLY);
  });
});
