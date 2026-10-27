import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { describe, it } from "node:test";

const widget = readFileSync(new URL("../src/mcp/dashboard-v1.html", import.meta.url), "utf8");

function extract(marker: string): string {
  const match = widget.match(new RegExp(`// BEGIN ${marker}([\\s\\S]*?)// END ${marker}`));
  assert.ok(match, `missing ${marker} block`);
  return match[1] ?? "";
}

const READY_STATUS = {
  status: "ok",
  zState: "active",
  reconciliation: { state: "disabled" },
  layers: { runtime: { status: "ready" } },
};

function presenceFor(approvals: unknown): string {
  const run = new Function(
    "state",
    `${extract("hud-team-board")}; return deriveHudPresence(hudPresenceInput());`,
  ) as (state: unknown) => string;
  return run({ status: READY_STATUS, approvals });
}

function approvalsPanelFor(approvals: unknown): { stage: string; source: string } {
  const nodes: Record<string, { textContent: string }> = {
    "approvals-stage": { textContent: "" },
    "approvals-source": { textContent: "" },
  };
  const run = new Function(
    "state",
    "byId",
    "text",
    `${extract("hud-team-board")}; renderApprovalsHonesty();`,
  ) as (state: unknown, byId: unknown, text: unknown) => void;
  run(
    { status: READY_STATUS, approvals, inbox: null },
    (id: string) => nodes[id] ?? null,
    (node: { textContent: string }, value: string) => {
      node.textContent = value;
    },
  );
  return {
    stage: nodes["approvals-stage"]!.textContent,
    source: nodes["approvals-source"]!.textContent,
  };
}

describe("HUD presence and approvals", () => {
  it("shows WAITING_FOR_APPROVAL when the snapshot reports pending proposals", () => {
    assert.equal(
      presenceFor({ status: "ready", proposedCount: 1, capped: false }),
      "waiting_for_approval",
    );
    assert.equal(presenceFor({ status: "ready", proposedCount: 0, capped: false }), "idle");
    assert.equal(presenceFor({ status: "unavailable", reason: "no convex" }), "idle");
    assert.equal(presenceFor(null), "idle");
    assert.doesNotMatch(widget, /deriveHudPresence\(\{ status: state\.status \}\)/);
  });

  it("stores the snapshot approvals and names the count on the Approvals panel", () => {
    assert.match(widget, /if \("approvals" in data\) state\.approvals = data\.approvals;/);
    // A full snapshot without approvals (the MCP dashboard path) drops a stale count.
    assert.match(
      widget,
      /else if \(data\.counts && typeof data\.counts === "object"\) state\.approvals = null;/,
    );
    assert.deepEqual(
      approvalsPanelFor({ status: "ready", proposedCount: 3, capped: false }).stage,
      "3 PROPOSED",
    );
    assert.equal(
      approvalsPanelFor({ status: "ready", proposedCount: 100, capped: true }).stage,
      "100+ PROPOSED",
    );
    const none = approvalsPanelFor({ status: "ready", proposedCount: 0, capped: false });
    assert.equal(none.stage, "NONE PROPOSED");
    assert.match(none.source, /does not approve, reject, or execute/);
    assert.equal(approvalsPanelFor({ status: "unavailable", reason: "x" }).stage, "UNKNOWN");
  });

  it("re-enables the microphone control when recognition.start() throws", () => {
    const start = widget.match(/function startRecognition\(\) \{([\s\S]*?)\n {10}\}\n/)?.[1];
    assert.ok(start, "startRecognition is missing");
    const tail = start.slice(start.indexOf("try { recognition.start(); }"));
    assert.match(
      tail,
      /catch \(error\) \{\s*state\.recognition = null;[\s\S]*?\}\s*updateMicrophoneControls\(\);\s*$/,
    );
  });

  it("repaints the backdrop when the snapshot changes its severity", () => {
    const source = extract("hud-backdrop");
    assert.match(
      source,
      /new MutationObserver\(\(\) => \{\s*severity = document\.body\.dataset\.backdropSeverity \|\| "UNKNOWN";/,
    );
    assert.match(source, /attributeFilter: \["data-backdrop-severity"\]/);
    assert.match(source, /function draw\(time\) \{[\s\S]*?const pal = palette\(\);/);
  });
});
