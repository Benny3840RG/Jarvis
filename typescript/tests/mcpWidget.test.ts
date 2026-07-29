import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { Script } from "node:vm";
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

  it("wires the real daily operations projection into its own dashboard view", () => {
    assert.match(widget, /data-view="operations"/);
    assert.match(widget, /id="view-operations"/);
    assert.match(widget, /state\.brief/);
    assert.match(widget, /renderOperations/);
    assert.match(widget, /Active projects/);
    assert.match(widget, /Quote pipeline/);
    assert.match(widget, /Equipment maintenance/);
    assert.match(widget, /OPERATIONS SNAPSHOT/i);
  });

  it("keeps drafts outside the sent pipeline and preserves cent-precise totals", () => {
    const audSource = widget.match(/const aud = new Intl\.NumberFormat[^;]+;/)?.[0];
    const renderSource = widget.match(
      /(function renderOperations\(\) \{[\s\S]*?\})\n        function renderActivity/,
    )?.[1];
    assert.ok(audSource, "AUD formatter was not found");
    assert.ok(renderSource, "operations renderer was not found");

    const elements = new Map<string, { id: string; textContent: string }>();
    const lists = new Map<string, unknown[]>();
    const byId = (id: string) => {
      const existing = elements.get(id);
      if (existing) return existing;
      const element = { id, textContent: "" };
      elements.set(id, element);
      return element;
    };
    const text = (element: { textContent: string }, value: unknown) => {
      element.textContent = value == null ? "" : String(value);
    };
    const fillList = (
      element: { id: string },
      items: unknown[],
      _renderer: (item: unknown) => unknown,
      _message: string,
    ) => lists.set(element.id, items);

    const state = {
      brief: {
        generatedAt: "2026-07-30T00:00:00.000Z",
        headline: "Quote truth fixture.",
        reminders: { dueCount: 0, upcomingCount: 0 },
        projects: { activeCount: 0, active: [] },
        quotes: {
          pipelineTotal: 330.35,
          acceptedTotal: 55.5,
          countsByStatus: { draft: 1, sent: 1, accepted: 1, declined: 0 },
          awaitingResponse: [{ number: "174", status: "sent", total: 330.35 }],
          drafts: [{ number: "175", status: "draft", total: 120 }],
        },
        maintenance: { dueCount: 0, dueSoonCount: 0, due: [], dueSoon: [] },
      },
    };
    const run = new Function(
      "state",
      "byId",
      "text",
      "fillList",
      "operationsRow",
      "empty",
      `"use strict"; ${audSource} ${renderSource}; renderOperations();`,
    );
    run(state, byId, text, fillList, () => ({}), () => ({}));

    assert.deepEqual(lists.get("operations-quote-list"), state.brief.quotes.awaitingResponse);
    assert.equal(elements.get("operations-quote-total")?.textContent, "$330.35");
    assert.equal(elements.get("brief-accepted-total")?.textContent, "$55.50");
    assert.equal(elements.get("brief-draft-count")?.textContent, "1");
  });

  it("ships syntactically valid embedded dashboard JavaScript", () => {
    const source = widget.match(/<script>([\s\S]*?)<\/script>/)?.[1];
    assert.ok(source, "dashboard script was not found");
    assert.doesNotThrow(() => new Script(source));
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
