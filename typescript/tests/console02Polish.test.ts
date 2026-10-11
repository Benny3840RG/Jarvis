import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { describe, it } from "node:test";

const widget = readFileSync(new URL("../src/mcp/dashboard-v1.html", import.meta.url), "utf8");

describe("Console 02 polish", () => {
  it("limits decorative chrome hiding to the desktop Focus view", () => {
    const pass2 = widget.match(/<style id="console-02-pass2">([\\s\\S]*?)<\\/style>/)?.[1];
    assert.ok(pass2, "Console 02 second presentation pass is missing");
    const unscopedRules = pass2.split("@media (min-width: 1400px)")[0] ?? "";
    assert.doesNotMatch(unscopedRules, /\\.rivets\\s*\\{\\s*display:\\s*none/);
    assert.doesNotMatch(unscopedRules, /\\.brand-legal\\s*\\{/);
    assert.match(
      pass2,
      /@media\\s*\\(min-width:\\s*1400px\\)\\s*\\{\\s*body\\[data-console-view="focus"\\] \\.rivets\\s*\\{\\s*display:\\s*none/,
    );
    assert.match(
      pass2,
      /body\\[data-console-view="focus"\\] \\.brand-legal\\s*\\{[^}]*clip:\\s*rect\\(0 0 0 0\\);/,
    );
    assert.match(widget, /<b class="brand-legal">Beez Treez<\\/b> Property Solutions/);
  });

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
