import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { describe, it } from "node:test";

const widget = readFileSync(new URL("../src/mcp/dashboard-v1.html", import.meta.url), "utf8");
const legibility = widget.match(/<style id="console-02-legibility">([\s\S]*?)<\/style>/)?.[1];

describe("Console 02 legibility", () => {
  it("keeps the dark palette for the system theme when the OS prefers light", () => {
    // The light palette put dark slate text on the dark photographic glass.
    assert.doesNotMatch(widget, /prefers-color-scheme:\s*light/);
    assert.doesNotMatch(widget, /html\[data-console-theme="system"\]\s+(input|select)/);
    assert.match(widget, /html\[data-console-theme="light"\]\s*\{[^}]*--muted:/);
  });

  it("is the last style layer so its overrides win", () => {
    assert.ok(legibility, "The legibility pass is missing");
    const styleIds = [...widget.matchAll(/<style id="([^"]+)">/g)].map((match) => match[1]);
    assert.equal(styleIds.at(-1), "console-02-legibility");
  });

  it("sets an 11px floor for real labels and denser glass behind text", () => {
    assert.ok(legibility);
    assert.match(legibility, /--glass:\s*rgba\(6, 10, 16, 0\.6\)/);
    assert.match(legibility, /body \.telemetry span,[\s\S]*?\{\s*font-size:\s*11px;/);
    assert.match(legibility, /body \.priority-row small,/);
    assert.match(legibility, /body \.panel-header > span,/);
    assert.match(legibility, /body \.lw-node \.lw-detail,[\s\S]*?font-size:\s*11px;/);
    assert.match(
      legibility,
      /body\[data-console-view="focus"\] \.console-deck \.console-col > \.plate\s*\{\s*background-color:\s*rgba\(7, 14, 22, 0\.56\);/,
    );
  });

  it("moves plate corner brackets clear of the text they frame", () => {
    assert.ok(legibility);
    assert.match(
      legibility,
      /\.console-deck \.plate\s*\{[^}]*background-position:\s*3px 3px, 3px 3px,/,
    );
  });

  it("fits the fixed lower deck and keeps the title plate clear of the nav rail", () => {
    assert.ok(legibility);
    const desktop = legibility.split("@media (min-width: 1400px)")[1];
    assert.ok(desktop, "The desktop lower deck sizing is missing");
    assert.match(desktop, /\.console-lower\s*\{[^}]*bottom:\s*16px;[^}]*height:\s*232px;/);
    assert.match(desktop, /\.gauge-face\s*\{\s*width:\s*232px;\s*height:\s*232px;/);
    assert.match(
      legibility,
      /body\[data-console-view="focus"\] \.title-plate\s*\{[^}]*flex-wrap:\s*wrap;/,
    );
  });

  it("scrolls crowded views and rails instead of clipping or hiding panels", () => {
    assert.ok(legibility);
    assert.match(legibility, /#view-livework\.active\s*\{[^}]*overflow-y:\s*auto;/);
    assert.match(
      legibility,
      /\.left-rail\s*\{[^}]*grid-template-rows:\s*max-content minmax\(max-content, 1fr\) max-content;[^}]*overflow-y:\s*auto;/,
    );
  });

  it("draws waveform axis labels above the flat no-signal line", () => {
    const waveform = widget.match(/<svg class="chart" viewBox="0 0 300 72"[\s\S]*?<\/svg>/)?.[0];
    assert.ok(waveform);
    assert.ok(
      waveform.indexOf('<path d="M8 36 H292"') < waveform.indexOf('<text x="6" y="40">50</text>'),
      "The axis labels must paint after the flat line",
    );
  });
});
