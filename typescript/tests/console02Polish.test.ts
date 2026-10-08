import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { describe, it } from "node:test";

const widget = readFileSync(new URL("../src/mcp/dashboard-v1.html", import.meta.url), "utf8");

describe("Console 02 polish", () => {
  it("keeps honesty notes on titles and shows a short tag", () => {
    assert.match(widget, /title="Ornament traces are not a reading\."/);
    assert.match(widget, /title="The wave is ornament, not a signal\."/);
    assert.match(widget, /title="Host meters are not exposed\. Needles stay parked\."/);
    assert.match(widget, /Facility names are not invented\./);
    assert.doesNotMatch(
      widget,
      /<p class="ornament-note">Ornament traces are not a reading\.<\/p>/,
    );
    assert.match(widget, /class="signal-tag"[^>]*>UNKNOWN<\/p>/);
    assert.match(widget, /id="tactical-caption">NO SIGNAL<\/p>/);
  });
});
