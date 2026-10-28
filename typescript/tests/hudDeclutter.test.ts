import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { describe, it } from "node:test";

const widget = readFileSync(new URL("../src/mcp/dashboard-v1.html", import.meta.url), "utf8");
const declutter = widget.match(/<style id="console-02-declutter">([\s\S]*?)<\/style>/)?.[1] ?? "";

function viewMarkup(name: string): string {
  const start = widget.indexOf(`<section class="view" id="view-${name}">`);
  assert.ok(start >= 0, `view-${name} is missing`);
  const next = widget.indexOf('<section class="view" id="view-', start + 1);
  return widget.slice(start, next > 0 ? next : undefined);
}

describe("HUD declutter", () => {
  it("shares one header and a full-width workspace across every view", () => {
    assert.ok(declutter, "The declutter style layer is missing");
    assert.match(
      widget,
      /body\[data-console-view\] \.left-rail,\s*body\[data-console-view\] \.right-rail,\s*body\[data-console-view\] \.bottom-band \{ display: none; \}/,
    );
    assert.match(widget, /body\[data-console-view\] \.telemetry \{ display: none; \}/);
    for (const control of ["brand", "team-nav", "top-actions", "title-plate"])
      assert.doesNotMatch(
        widget,
        new RegExp(`body\\[data-console-view="focus"\\] \\.${control}\\b`),
      );
    assert.doesNotMatch(widget, /<section class="bottom-band">/);
  });

  it("moves each useful rail panel to the view it belongs to", () => {
    assert.match(viewMarkup("board"), /id="category-bars"/);
    assert.match(viewMarkup("board"), /id="completion-ring"/);
    assert.match(viewMarkup("systems"), /id="provider-reachability"/);
    assert.match(viewMarkup("systems"), /id="activity-list"/);
    assert.match(viewMarkup("systems"), /id="approvals-stage"/);
    assert.match(viewMarkup("livework"), /id="panel-crew" data-hud-panel="crew"/);
  });

  it("opens command capture as a drawer from any view", () => {
    assert.match(
      widget,
      /<button class="pill capture-toggle" id="capture-toggle" type="button" aria-controls="capture-drawer" aria-expanded="false">\+ Add<\/button>/,
    );
    assert.match(
      widget,
      /<section class="capture-drawer" id="capture-drawer" aria-label="Command capture" hidden>[\s\S]*?id="capture-form"/,
    );
    assert.match(widget, /toggle\.setAttribute\("aria-expanded", String\(open\)\);/);
    assert.match(widget, /event\.key === "Escape" && !byId\("capture-drawer"\)\.hidden/);
    assert.match(declutter, /\.capture-drawer\[hidden\] \{ display: none; \}/);
  });

  it("scrolls long panels inside themselves instead of clipping them", () => {
    assert.match(declutter, /\.workspace \.scroll-list,[^{]*\{[^}]*overflow-y: auto;/);
    assert.match(declutter, /grid-template-areas:\s*"snapshot snapshot inbox timeline"/);
    assert.match(
      declutter,
      /\.systems-view \{ grid-template-columns: minmax\(0, 1fr\) minmax\(0, 0\.9fr\) minmax\(0, 1fr\);/,
    );
  });

  it("keeps the legibility layer last so its 11px floor still wins", () => {
    const styleIds = [...widget.matchAll(/<style id="([^"]+)">/g)].map((match) => match[1]);
    assert.deepEqual(styleIds.slice(-2), ["console-02-declutter", "console-02-legibility"]);
  });
});
