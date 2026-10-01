import assert from "node:assert/strict";
import { describe, it } from "node:test";

import { parseProjectScheduledDate } from "../src/projects/project.js";

describe("project scheduled date validation", () => {
  for (const value of [
    "2026-10-09",
    "2024-02-29",
    "2000-02-29",
    "0001-01-01",
    "0099-12-31",
    "0100-01-01",
    "9999-12-31",
  ]) {
    it(`accepts the real calendar date ${value}`, () => {
      assert.equal(parseProjectScheduledDate(value), value);
    });
  }

  it("preserves trimming at the shared boundary", () => {
    assert.equal(parseProjectScheduledDate(" 2026-10-09 "), "2026-10-09");
  });

  for (const value of [
    "2026-02-29",
    "1900-02-29",
    "2100-02-29",
    "2026-02-30",
    "2026-04-31",
    "2026-00-01",
    "2026-13-01",
    "2026-01-00",
    "2026-01-32",
    "0000-01-01",
  ]) {
    it(`rejects the impossible calendar date ${value}`, () => {
      assert.throws(() => parseProjectScheduledDate(value), /not a valid calendar date/);
    });
  }

  for (const value of [
    "",
    "next Friday",
    "2026-1-09",
    "2026-10-9",
    "2026-10-09T00:00:00Z",
    "10000-01-01",
    null,
    undefined,
    20261009,
    {},
  ]) {
    it(`rejects a non-date value: ${JSON.stringify(value)}`, () => {
      assert.throws(() => parseProjectScheduledDate(value), /ISO date \(YYYY-MM-DD\)/);
    });
  }
});
