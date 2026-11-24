import assert from "node:assert/strict";
import { describe, it } from "node:test";

import { bundleHud } from "../src/mcp/hud/bundle.mjs";

function loadSummary(): (
  tasks: number,
  overdue: number,
  errands: number,
  loaded: boolean,
) => string {
  const match = bundleHud().match(/\/\/ BEGIN today-summary[\s\S]*?\/\/ END today-summary/);
  assert.ok(match, "today-summary block not found in the HUD");
  return new Function(`"use strict"; ${match[0]}\n return todaySummaryText;`)();
}

describe("HUD Today summary line", () => {
  const summary = loadSummary();

  it("lists only what is on", () => {
    assert.equal(summary(2, 0, 1, true), "2 tasks · 1 errand");
    assert.equal(summary(1, 1, 0, true), "1 task · 1 overdue reminder");
    assert.equal(summary(0, 3, 0, true), "3 overdue reminders");
  });

  it("says all clear on an empty day, never “0 tasks”", () => {
    assert.equal(summary(0, 0, 0, true), "All clear. Nothing needs doing right now.");
  });

  it("waits for the lists before claiming the day is clear", () => {
    assert.equal(summary(0, 0, 0, false), "Loading your day…");
  });
});
