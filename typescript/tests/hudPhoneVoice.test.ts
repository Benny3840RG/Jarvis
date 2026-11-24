import assert from "node:assert/strict";
import { describe, it } from "node:test";

import { bundleHud } from "../src/mcp/hud/bundle.mjs";

const html = bundleHud();

describe("HUD everyday views on a phone", () => {
  it("hides the system chips on Voice, Task Board and Reminders as well as Today", () => {
    for (const view of ["today", "voice", "board", "reminders"]) {
      assert.match(
        html,
        new RegExp(`body\\[data-console-view="${view}"\\] \\.telemetry`),
        `${view} hides telemetry on a phone`,
      );
    }
  });

  it("shows spoken-reply problems but not routine voice diagnostics on a phone", () => {
    assert.match(
      html,
      /#voice-latency, #voice-output-status:not\(\[data-tone="warn"\]\) \{ display: none; \}/,
    );
  });

  it("explains the voice screen in plain words", () => {
    assert.match(html, /If I get it wrong, say “Nolan undo”\./);
    assert.match(html, /id="voice-result" data-tone="muted">Ready when you are\.</);
    assert.doesNotMatch(html, /fails closed\.<\/p>/);
  });
});
