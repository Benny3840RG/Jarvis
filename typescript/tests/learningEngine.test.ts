import assert from "node:assert/strict";
import { describe, it } from "node:test";

import { LearningEngine } from "../src/adaptive/learningEngine.js";

describe("LearningEngine per-intent stats", () => {
  it("records successes and failures per intent with a derived success rate", () => {
    const engine = new LearningEngine();
    engine.record("planning", true);
    engine.record("planning", true);
    engine.record("planning", false);
    engine.record("memory", false);

    const stats = engine.getStats();
    assert.deepEqual(stats.planning, {
      total: 3,
      successes: 2,
      failures: 1,
      successRate: 2 / 3,
    });
    assert.deepEqual(stats.memory, {
      total: 1,
      successes: 0,
      failures: 1,
      successRate: 0,
    });
  });

  it("shows different success rates for different intents", () => {
    const engine = new LearningEngine();
    engine.record("planning", true);
    engine.record("planning", true);
    engine.record("general", false);
    engine.record("general", false);

    const stats = engine.getStats();
    assert.equal(stats.planning.successRate, 1);
    assert.equal(stats.general.successRate, 0);
    assert.notEqual(stats.planning.successRate, stats.general.successRate);
  });

  it("flags intents whose failures outnumber successes", () => {
    const engine = new LearningEngine();
    engine.record("planning", true);
    engine.record("memory", false);
    engine.record("memory", false);
    engine.record("memory", true);

    assert.deepEqual(engine.strugglingIntents(), ["memory"]);
  });

  it("returns empty stats before anything is recorded", () => {
    assert.deepEqual(new LearningEngine().getStats(), {});
    assert.deepEqual(new LearningEngine().strugglingIntents(), []);
  });

  it("keeps the existing observe/suggest behaviour", () => {
    const engine = new LearningEngine();
    assert.equal(
      engine.suggest(),
      "Next action: confirm the main objective and break it into steps.",
    );
    engine.observe("plan workshop task");
    assert.equal(engine.suggest(), "Next action: prepare a workshop-focused task plan.");
  });
});
