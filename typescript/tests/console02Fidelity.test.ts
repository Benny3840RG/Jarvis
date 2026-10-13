import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { describe, it } from "node:test";

const widget = readFileSync(new URL("../src/mcp/dashboard-v1.html", import.meta.url), "utf8");
const fidelityStyle = widget.match(/<style id="console-02-fidelity">([\s\S]*?)<\/style>/)?.[1];

describe("Console 02 presentation regressions", () => {
  it("keeps the added glass and ornament layers non-interactive", () => {
    assert.ok(fidelityStyle, "Console 02 fidelity stylesheet is missing");
    assert.match(widget, /<div class="crt-glass" aria-hidden="true"><\/div>/);
    assert.match(fidelityStyle, /\.crt-glass\s*\{[^}]*pointer-events:\s*none\s*;/);
    assert.match(fidelityStyle, /\.ornament\s*\{[^}]*pointer-events:\s*none\s*;/);
  });

  it("disables decorative core animation with reduced motion", () => {
    assert.ok(fidelityStyle, "Console 02 fidelity stylesheet is missing");
    assert.match(
      fidelityStyle,
      /@media\s*\(prefers-reduced-motion:\s*reduce\)\s*\{[\s\S]*?\.core-rings[^}]*animation:\s*none\s*!important/,
    );
  });

  it("labels decorative charts instead of presenting invented readings", () => {
    assert.match(widget, /class="ornament" aria-hidden="true"/);
    assert.match(widget, /Ornament traces are not a reading\./);
    assert.match(widget, /The wave is ornament, not a signal\./);
    assert.match(widget, /id="predictor-state">UNKNOWN<\/p>/);
    assert.match(widget, /id="waveform-state">No waveform signal\.<\/p>/);
    assert.match(widget, /id="predictor-line" points=""/);
  });
});
