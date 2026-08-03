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

describe("LearningEngine tips", () => {
  it("returns at least one tip even with no prior activity", () => {
    const engine = new LearningEngine();
    const tips = engine.tips();
    assert.ok(tips.length > 0);
  });

  it("surfaces a struggling-intent tip when failures outnumber successes", () => {
    const engine = new LearningEngine();
    engine.record("memory", false);
    engine.record("memory", false);

    const tips = engine.tips();
    assert.ok(tips.some((t) => t.includes('"memory"')));
  });

  it("identifies the most-used intent and suggests tracking it", () => {
    const engine = new LearningEngine();
    engine.record("planning", true);
    engine.record("planning", true);
    engine.record("general", true);

    const tips = engine.tips();
    assert.ok(tips.some((t) => t.includes('"planning"') && t.includes("most-used")));
  });

  it("prompts the user to try planning mode when it has not been used", () => {
    const engine = new LearningEngine();
    const tips = engine.tips();
    assert.ok(tips.some((t) => t.toLowerCase().includes("planning")));
  });

  it("omits the planning tip when planning has already been observed", () => {
    const engine = new LearningEngine();
    engine.observe("plan a project");

    const tips = engine.tips();
    assert.ok(!tips.some((t) => t.includes("planning mode yet")));
  });

  it("omits the summary tip when summary has already been observed", () => {
    const engine = new LearningEngine();
    engine.observe("show summary");

    const tips = engine.tips();
    assert.ok(!tips.some((t) => t.includes("Type 'summary'")));
  });
});
