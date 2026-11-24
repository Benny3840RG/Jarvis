import assert from "node:assert/strict";
import { describe, it } from "node:test";

import { smallTalkReply } from "../src/voice/voiceSmallTalk.js";

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
