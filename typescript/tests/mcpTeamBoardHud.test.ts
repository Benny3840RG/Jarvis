import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { describe, it } from "node:test";

const widget = readFileSync(new URL("../src/mcp/dashboard-v1.html", import.meta.url), "utf8");

function extract(marker: string): string {
  const match = widget.match(new RegExp(`// BEGIN ${marker}([\\s\\S]*?)// END ${marker}`));
  assert.ok(match, `missing ${marker} block`);
  return match[1] ?? "";
}

describe("Team Board HUD", () => {
  it("keeps the single limits NOW chip and does not invent a crew", () => {
    assert.deepEqual(
      [...widget.matchAll(/data-now-chip="([^"]+)"/g)].map((match) => match[1]),
      ["limits"],
    );
    assert.match(widget, /id="chip-crew"/);
    assert.match(widget, /Crew · UNKNOWN/);
    assert.match(widget, /Names are not invented/);
    assert.doesNotMatch(widget, /Maya|Jordan|Alex|Sam/);
    assert.match(widget, /id="hud-backdrop"/);
    assert.match(widget, /data-hud-panel="now"/);
    assert.match(widget, /Next 3/);
    assert.match(widget, /active\.slice\(1, 4\)/);
    assert.match(widget, /registerHudPanel/);
    assert.match(widget, /JARVIS TOTALITY/);
    assert.match(widget, /Team Board/);
  });

  it("does not add widget write paths for delete or approval", () => {
    assert.doesNotMatch(widget, /delete_task|delete_reminder|innerHTML/);
    assert.doesNotMatch(widget, /approve_tool_action|reject_tool_action|\/approve|\/execute/);
    assert.doesNotMatch(widget, /JARVIS_APPROVAL_TOKEN\s*=/);
    assert.match(widget, /does not approve, reject, or execute/);
  });

  it("ranks backdrop severity without painting unread limits as a runtime outage", () => {
    const source = extract("hud-team-board");
    const derive = new Function(`${source}; return deriveBackdropSeverity;`)() as (
      snapshot: unknown,
    ) => string;
    assert.equal(derive(null), "UNKNOWN");
    assert.equal(derive({ status: null, limitsState: "UNKNOWN" }), "UNKNOWN");
    assert.equal(
      derive({
        status: { status: "ok", zState: "active" },
        limitsState: "UNKNOWN",
        inbox: { items: [] },
      }),
      "OK",
    );
    assert.equal(
      derive({
        status: { status: "ok", zState: "active" },
        limitsState: "WARN",
        inbox: { items: [] },
      }),
      "WARN",
    );
    assert.equal(
      derive({
        status: { status: "ok", zState: "active" },
        limitsState: "STOPPED",
        inbox: { items: [{ severity: "informational" }] },
      }),
      "STOPPED",
    );
    assert.equal(
      derive({
        status: { status: "unavailable", zState: "active" },
        limitsState: "OK",
      }),
      "STOPPED",
    );
    assert.equal(
      derive({
        status: { status: "ok", zState: "suspended" },
        limitsState: "OK",
      }),
      "STOPPED",
    );
    assert.equal(
      derive({
        status: { status: "degraded", zState: "active" },
        limitsState: "UNKNOWN",
        inbox: null,
      }),
      "WARN",
    );
    assert.equal(
      derive({
        status: { status: "ok", zState: "active" },
        inbox: { items: [{ severity: "critical" }] },
      }),
      "STOPPED",
    );
    assert.equal(
      derive({
        status: { status: "ok", zState: "active" },
        liveWork: { status: "ready", pipeline: { state: "REPAIR_REQUIRED" } },
      }),
      "WARN",
    );
  });

  it("derives presence from status and does not invent listening or processing", () => {
    const source = extract("hud-team-board");
    const derive = new Function(`${source}; return deriveHudPresence;`)() as (
      input: unknown,
    ) => string;
    assert.equal(derive({}), "connecting");
    assert.equal(
      derive({ status: { status: "unavailable", zState: "active", layers: {} } }),
      "offline",
    );
    assert.equal(
      derive({
        status: {
          status: "ok",
          zState: "active",
          reconciliation: { state: "disabled" },
          layers: { runtime: { status: "ready" } },
        },
      }),
      "idle",
    );
    assert.equal(
      derive({
        status: {
          status: "ok",
          zState: "active",
          reconciliation: { state: "disabled" },
          layers: { runtime: { status: "ready" } },
        },
        proposedApprovalCount: 1,
      }),
      "waiting_for_approval",
    );
    for (const presence of ["listening", "processing", "executing"]) {
      assert.equal(derive({ status: null }) === presence, false);
    }
    assert.doesNotMatch(source, /listening|processing|executing/);
  });

  it("pauses the instrument when the tab is hidden or motion is reduced", () => {
    const source = extract("hud-backdrop");
    assert.match(source, /document\.hidden/);
    assert.match(source, /prefers-reduced-motion:\s*reduce/);
    assert.match(source, /cancelAnimationFrame/);
    assert.match(source, /requestAnimationFrame/);
    assert.match(source, /INSTRUMENT STILL/);
    assert.match(source, /INSTRUMENT LIVE/);
    assert.doesNotMatch(source, /\b447\b|\b75%|\b109\b/);
    assert.match(widget, /data-console-motion/);
  });
});
