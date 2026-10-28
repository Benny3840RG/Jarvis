import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { describe, it } from "node:test";

const widget = readFileSync(new URL("../src/mcp/dashboard-v1.html", import.meta.url), "utf8");

describe("Console 02 polish", () => {
  it("reserves content space for the Now action and all three queued tasks", () => {
    const controls = widget.match(
      /<style id="console-02-readable-controls">([\s\S]*?)<\/style>/,
    )?.[1];
    assert.ok(controls, "The compact instrument frame must reserve space for its task controls");
    assert.match(
      controls,
      /\.now-strip\s*\{[^}]*position:\s*static;[^}]*height:\s*auto;[^}]*max-height:\s*none;/,
    );
    assert.match(
      controls,
      /\.queue-panel\s*\{[^}]*grid-template-rows:\s*auto auto minmax\(0,\s*1fr\);/,
    );
    assert.match(
      controls,
      /#focus-queue\s*\{[^}]*grid-template-columns:\s*repeat\(3,\s*minmax\(0,\s*1fr\)\);/,
    );
    assert.match(
      controls,
      /#current-actions \.primary-button\s*\{[^}]*min-height:\s*var\(--touch\);/,
    );
  });

  it("gives real status and tactical labels space before decorative marks", () => {
    const controls = widget.match(
      /<style id="console-02-readable-controls">([\s\S]*?)<\/style>/,
    )?.[1];
    assert.ok(controls, "The instrument layout must keep real labels readable");
    assert.match(controls, /#dev-status\s*\{[^}]*order:\s*-1;/);
    assert.match(controls, /\.tac-map\s*\{[^}]*bottom:\s*36px;[^}]*overflow-y:\s*auto;/);
    assert.match(controls, /\.tac-plate h2\s*\{[^}]*bottom:\s*2px;/);
  });

  it("lets the narrow Focus overview grow around tactical content", () => {
    const controls = widget.match(
      /<style id="console-02-readable-controls">([\s\S]*?)<\/style>/,
    )?.[1];
    assert.ok(controls);
    const narrow = controls.split("@media (max-width: 1399px)")[1];
    assert.ok(narrow, "The narrow layout must size the overview to its content");
    assert.match(narrow, /\.console-deck\s*\{[^}]*grid-template-rows:\s*auto;/);
    assert.match(narrow, /\.fader-scale\s*\{\s*display:\s*none;/);
    assert.match(
      narrow,
      /\.console-col > \.plate\s*\{[^}]*flex:\s*0 0 auto;[^}]*min-height:\s*min-content;/,
    );
    assert.match(
      narrow,
      /\.overview-plate\s*\{[^}]*height:\s*auto;[^}]*min-height:\s*min-content;/,
    );
    assert.match(
      narrow,
      /\.core-stage\s*\{[^}]*width:\s*min\(320px,\s*100%\);[^}]*height:\s*auto;/,
    );
  });

  it("scrolls live right-column panels instead of shrinking their labels away", () => {
    const controls = widget.match(
      /<style id="console-02-readable-controls">([\s\S]*?)<\/style>/,
    )?.[1];
    assert.ok(controls);
    assert.match(controls, /\.col-right\s*\{[^}]*overflow-y:\s*auto;/);
    assert.match(
      controls,
      /\.console-deck \.col-right > \.plate\s*\{[^}]*flex:\s*0 0 auto;[^}]*min-height:\s*min-content;/,
    );
    assert.match(controls, /\.col-left > \.plate:last-child\s*\{[^}]*min-height:\s*min-content;/);
    assert.match(controls, /#tile-tasks\s*\{\s*line-height:\s*1\.4;/);
  });

  it("limits decorative chrome hiding to desktop widths, shared by every view", () => {
    const pass2 = widget.match(/<style id="console-02-pass2">([\s\S]*?)<\/style>/)?.[1];
    assert.ok(pass2, "Console 02 second presentation pass is missing");
    const unscopedRules = pass2.split("@media (min-width: 1400px)")[0] ?? "";
    assert.doesNotMatch(unscopedRules, /\.rivets\s*\{\s*display:\s*none/);
    assert.doesNotMatch(unscopedRules, /\.brand-legal\s*\{/);
    assert.match(
      pass2,
      /@media\s*\(min-width:\s*1400px\)\s*\{\s*body\[data-console-view\] \.rivets\s*\{\s*display:\s*none/,
    );
    assert.match(
      pass2,
      /body\[data-console-view\] \.brand-legal\s*\{[^}]*clip:\s*rect\(0 0 0 0\);/,
    );
    assert.match(widget, /<b class="brand-legal">Beez Treez<\/b> Property Solutions/);
  });

  it("keeps the new opaque bezel and title treatment inside wide Focus", () => {
    assert.match(widget, /class="bezel-art bezel-base"/);
    assert.match(widget, /id="baseline-frame-brass"/);
    assert.match(widget, /class="bezel-art bezel-focus"/);
    const controls = widget.match(
      /<style id="console-02-readable-controls">([\s\S]*?)<\/style>/,
    )?.[1];
    assert.ok(controls);
    assert.match(controls, /\.bezel-focus\s*\{\s*display:\s*none;/);
    assert.match(
      controls,
      /@media \(min-width: 781px\) and \(max-width: 1399px\)\s*\{[^}]*padding-inline:\s*84px;/,
    );
    const desktop = controls.split("@media (min-width: 1400px)")[1];
    assert.match(desktop, /body\[data-console-view="focus"\] \.bezel-base\s*\{\s*display:\s*none;/);
    assert.match(
      desktop,
      /body\[data-console-view="focus"\] \.bezel-focus\s*\{\s*display:\s*block;/,
    );
    const fidelity = widget.match(/<style id="console-02-fidelity">([\s\S]*?)<\/style>/)?.[1];
    assert.ok(fidelity);
    assert.doesNotMatch(fidelity.split("@media (min-width: 1400px)")[0], /\.title-plate\s*\{/);
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
