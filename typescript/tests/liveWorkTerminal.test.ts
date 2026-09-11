import assert from "node:assert/strict";
import { describe, it } from "node:test";

import { foldLiveWorkPipeline, type LiveWorkPipeline } from "../src/development/liveWork.js";
import { renderLiveWorkTerminal } from "../src/development/liveWorkTerminal.js";
import { stripAnsi, visibleWidth } from "../src/terminal/ansi.js";

const NOW = new Date("2026-09-11T14:02:07.000Z");

function pipeline(state: LiveWorkPipeline["state"] = "VERIFYING"): LiveWorkPipeline {
  return foldLiveWorkPipeline({
    omegaReadiness: { allowed: false, failures: ["residual-uncertainty-not-recorded"] },
    subject: {
      subjectVersion: 7,
      orchestrationRunId: "mission-42-run",
      orchestrationNodeId: "development",
      fencingToken: 3,
      subjectId: "mission-42",
      state,
      repository: "Benny3840RG/Jarvis",
      branch: "agent/live-work-terminal",
      updatedAt: Date.parse("2026-09-11T13:58:00.000Z"),
    },
    events: [
      {
        eventId: "e1",
        eventType: "DEV_TRANSITION_COMMITTED",
        occurredAt: "2026-09-11T13:40:00.000Z",
        from: "CLAIMED",
        to: "BUILDING",
        reasonCodes: [],
        hasMergeReceipt: false,
      },
      {
        eventId: "e2",
        eventType: "DEV_TRANSITION_COMMITTED",
        occurredAt: "2026-09-11T13:58:00.000Z",
        from: "BUILDING",
        to: "VERIFYING",
        reasonCodes: [],
        hasMergeReceipt: false,
      },
    ],
    omegaMission: {
      missionId: "mission-42",
      objective: "Ship the terminal live-work monitor",
      state: "active",
      acceptanceCriteria: [{ status: "satisfied" }, { status: "unverified" }],
    },
    workerStep: null,
    generatedAt: NOW.toISOString(),
  });
}

function lines(output: string): string[] {
  return output.split("\n");
}

describe("renderLiveWorkTerminal", () => {
  it("frames every line to the exact panel width", () => {
    for (const width of [64, 80, 96, 120]) {
      const output = renderLiveWorkTerminal(
        { status: "available", pipeline: pipeline() },
        { width, now: NOW },
      );
      for (const line of lines(output)) {
        assert.equal(visibleWidth(line), width, `width ${width}: "${stripAnsi(line)}"`);
        assert.match(stripAnsi(line), /^[┌│├└]/);
        assert.match(stripAnsi(line), /[┐│┤┘]$/);
      }
    }
  });

  it("clamps the width to [64, 120]", () => {
    const narrow = renderLiveWorkTerminal(
      { status: "available", pipeline: pipeline() },
      { width: 10, now: NOW },
    );
    const wide = renderLiveWorkTerminal(
      { status: "available", pipeline: pipeline() },
      { width: 999, now: NOW },
    );
    assert.equal(visibleWidth(lines(narrow)[0]!), 64);
    assert.equal(visibleWidth(lines(wide)[0]!), 120);
  });

  it("emits no ANSI escapes when color is disabled", () => {
    const output = renderLiveWorkTerminal(
      { status: "available", pipeline: pipeline() },
      { color: false, now: NOW },
    );
    assert.equal(stripAnsi(output), output);
  });

  it("renders the mission, all nine pipeline nodes, the rail and bindings", () => {
    const text = stripAnsi(
      renderLiveWorkTerminal({ status: "available", pipeline: pipeline() }, { now: NOW }),
    );
    assert.match(text, /Ship the terminal live-work monitor/);
    assert.match(text, /Benny3840RG\/Jarvis · agent\/live-work-terminal/);
    for (const label of [
      "MISSION",
      "STAGE",
      "ISSUE",
      "PR",
      "WORKER",
      "REVIEW",
      "CI",
      "MERGE",
      "ΩΣ",
    ]) {
      assert.ok(text.includes(label), `missing node ${label}`);
    }
    assert.match(text, /RAIL/);
    assert.match(text, /v7 · run mission-42-run · node development · fence 3/);
    assert.match(text, /ΩΣ readiness: NOT READY \(1\)/);
    assert.match(text, /residual-uncertainty-not-recorded/);
  });

  it("lists mission events newest-first from the snapshot's own timestamps", () => {
    const text = stripAnsi(
      renderLiveWorkTerminal({ status: "available", pipeline: pipeline() }, { now: NOW }),
    );
    const verifying = text.indexOf("BUILDING → VERIFYING");
    const building = text.indexOf("CLAIMED → BUILDING");
    assert.ok(verifying > 0 && building > 0);
    assert.ok(verifying < building, "newest event must appear first");
  });

  it("shows a blocked node with the blocked glyph, never a fabricated pass", () => {
    const text = stripAnsi(
      renderLiveWorkTerminal(
        { status: "available", pipeline: pipeline("INDETERMINATE") },
        { now: NOW },
      ),
    );
    assert.match(text, /✖ +MERGE +Merge outcome indeterminate/);
  });

  it("reports a node's missing data honestly rather than inventing it", () => {
    const bare = foldLiveWorkPipeline({
      omegaReadiness: { allowed: false, failures: ["omega-mission-not-linked"] },
      subject: { subjectId: "mission-x", state: "SPECIFIED", updatedAt: 0 },
      events: [],
      omegaMission: null,
      workerStep: null,
      generatedAt: NOW.toISOString(),
    });
    const text = stripAnsi(
      renderLiveWorkTerminal({ status: "available", pipeline: bare }, { now: NOW }),
    );
    assert.match(text, /ISSUE +Not recorded by the mission yet\./);
    assert.match(text, /PR +Not recorded by the mission yet\./);
    assert.match(text, /No mission events recorded yet\./);
  });

  it("renders a calm idle panel when no mission is in flight", () => {
    const output = renderLiveWorkTerminal({ status: "available", pipeline: null }, { now: NOW });
    const text = stripAnsi(output);
    assert.match(text, /NO MISSION IN FLIGHT/);
    assert.match(text, /The development pipeline is clear\./);
    assert.doesNotMatch(text, /PIPELINE/);
    for (const line of lines(output)) assert.equal(visibleWidth(line), 96);
  });

  it("renders a red UNAVAILABLE panel that surfaces the reason verbatim", () => {
    const output = renderLiveWorkTerminal(
      {
        status: "unavailable",
        reason: "Could not reach Jarvis: connect ECONNREFUSED 127.0.0.1:3000",
      },
      { now: NOW },
    );
    const text = stripAnsi(output);
    assert.match(text, /LIVE-WORK LINK UNAVAILABLE/);
    assert.match(text, /connect ECONNREFUSED 127\.0\.0\.1:3000/);
    assert.doesNotMatch(text, /NO MISSION IN FLIGHT/);
  });

  it("keeps a MERGED mission's ΩΣ-ready headline distinct from completion", () => {
    const text = stripAnsi(
      renderLiveWorkTerminal({ status: "available", pipeline: pipeline("MERGED") }, { now: NOW }),
    );
    assert.match(text, /MERGED — ΩΣ NOT READY/);
    assert.doesNotMatch(text, /STATE +COMPLETE/);
  });
});
