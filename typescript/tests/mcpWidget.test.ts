import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { describe, it } from "node:test";

const widget = readFileSync(
  new URL("../src/mcp/dashboard-v1.html", import.meta.url),
  "utf8",
);

describe("Jarvis preview widget", () => {
  it("uses the MCP Apps bridge inside the landscape command-centre HUD", () => {
    assert.match(widget, /ui\/initialize/);
    assert.match(widget, /ui\/notifications\/tool-result/);
    assert.match(widget, /tools\/call/);
    assert.match(widget, /JARVIS \/\/ OPERATOR CONSOLE/);
    assert.match(widget, /LANDSCAPE COMMAND CENTRE/);
    assert.match(widget, /class="hud-grid"/);
  });

  it("keeps real Jarvis task, reminder, refresh, and system controls wired", () => {
    assert.match(widget, /show_jarvis_dashboard/);
    assert.match(widget, /create_task/);
    assert.match(widget, /complete_task/);
    assert.match(widget, /create_reminder/);
    assert.match(widget, /status\.layers/);
    assert.match(widget, /Task load by domain/);
    assert.match(widget, /Reminder timing distribution/);
  });

  it("uses the violet-green HUD treatment while retaining Beez Treez branding", () => {
    assert.match(widget, /#b933ff/i);
    assert.match(widget, /#39ff88/i);
    assert.match(widget, /#ff7a18/i);
    assert.match(widget, /--brand-gradient/);
    assert.match(widget, /Beez Treez/);
  });

  it("does not pretend unsupported telemetry exists", () => {
    assert.doesNotMatch(widget, /\bCPU\b|\bGPU\b|token usage|API latency/i);
  });

  it("does not contain Jarvis or OpenAI credential names", () => {
    assert.doesNotMatch(widget, /JARVIS_SERVICE_TOKEN/);
    assert.doesNotMatch(widget, /OPENAI_API_KEY/);
    assert.doesNotMatch(widget, /CONVEX_DEPLOY_KEY/);
  });
});
