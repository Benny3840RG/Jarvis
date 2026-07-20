import assert from "node:assert/strict";
import { describe, it } from "node:test";

import { ConversationService } from "../src/runtime/conversationService.js";
import { IntentRouter } from "../src/runtime/intentRouter.js";
import { classifyIntent } from "../src/runtime/intentClassifier.js";

describe("intent classification", () => {
  it("recognises greetings as whole words", () => {
    for (const message of ["hello there", "hi Jarvis", "hey", "Good morning", "howdy"]) {
      assert.equal(classifyIntent(message), "greeting", message);
    }
  });

  it("does not treat a keyword hidden inside another word as that intent", () => {
    // Regression: "this" contains "hi", "they" contains "hey" — these must not
    // be misread as greetings the way the old String.includes checks did.
    assert.equal(classifyIntent("I need this plan"), "planning");
    assert.equal(classifyIntent("they should ship it"), "general");
    assert.equal(classifyIntent("which item is next"), "general");
  });

  it("maps planning phrasings and synonyms to a single intent", () => {
    for (const message of [
      "plan my day",
      "schedule a task",
      "add a task",
      "kick off the plan",
      "set up the workshop plan",
      "help me organise the week",
    ]) {
      assert.equal(classifyIntent(message), "planning", message);
    }
  });

  it("recognises memory requests", () => {
    for (const message of ["remember this", "what is my name", "recall my preference"]) {
      assert.equal(classifyIntent(message), "memory", message);
    }
  });

  it("falls back to general for unrelated text", () => {
    assert.equal(classifyIntent("the weather is nice"), "general");
    assert.equal(classifyIntent(""), "general");
  });

  it("keeps the two entry points in agreement (single source of truth)", () => {
    const conversation = new ConversationService();
    const router = new IntentRouter();
    const samples = [
      "hello there",
      "I need this plan",
      "schedule a task",
      "what is my name",
      "the weather is nice",
      "plan workshop task",
    ];
    for (const message of samples) {
      assert.equal(conversation.parse(message).intent, router.route(message), message);
    }
  });

  it("preserves the established planning phrase used by the CLI wiring", () => {
    assert.equal(classifyIntent("plan workshop task"), "planning");
  });
});
