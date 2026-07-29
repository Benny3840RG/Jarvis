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
      /(function renderOperations\(\) \{[\s\S]*?\})\n\s+function renderActivity/,
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

    const lifecycleQuote = {
      quoteId: "lifecycle-174",
      clientId: "client-1",
      projectId: "project-1",
      number: "174",
      currentRevision: 2,
      aggregateVersion: 4,
      revisionStatus: "finalized",
      commercialStatus: "open",
      total: 330.35,
      currency: "AUD",
      updatedAt: 3,
    };
    const state = {
      quotes: [lifecycleQuote],
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
      "quotePipelineRow",
      "renderQuoteDetail",
      "empty",
      `"use strict"; ${audSource} ${renderSource}; renderOperations();`,
    );
    run(
      state,
      byId,
      text,
      fillList,
      () => ({}),
      () => ({}),
      () => {},
      () => ({}),
    );

    assert.deepEqual(lists.get("operations-quote-list"), [lifecycleQuote]);
    assert.equal(elements.get("operations-quote-total")?.textContent, "$330.35");
    assert.equal(elements.get("brief-accepted-total")?.textContent, "$55.50");
    assert.equal(elements.get("brief-draft-count")?.textContent, "1");
  });

  it("opens a pipeline quote in the read-only inspector", async () => {
    const openSource = widget.match(
      /(async function openQuote\(summary\) \{[\s\S]*?\})\n\s+function renderQuoteDetail/,
    )?.[1];
    const renderSource = widget.match(
      /(function renderQuoteDetail\(\) \{[\s\S]*?\})\n\s+function renderOperations/,
    )?.[1];
    assert.ok(openSource, "quote selection handler was not found");
    assert.ok(renderSource, "quote detail renderer was not found");
    assert.match(widget, /LOADING QUOTE/);
    assert.match(widget, /QUOTE NOT FOUND/);
    assert.match(widget, /RETRY/);

    const SNAPSHOT = {
      aggregate: {
        quoteId: "quote / 174",
        ownerId: "owner-1",
        clientId: "client-1",
        projectId: "project-1",
        number: "174",
        currentRevision: 2,
        currentRevisionId: "revision-2",
        aggregateVersion: 4,
        commercialStatus: "open",
        createdAt: 10,
        updatedAt: 20,
      },
      revision: {
        revisionId: "revision-2",
        ownerId: "owner-1",
        quoteId: "quote / 174",
        revision: 2,
        revisionVersion: 3,
        status: "finalized",
        lineItems: [
          { description: "Garden preparation", quantity: 1, unitPrice: 1200.25 },
          { description: "PebbleLock installation", quantity: 1, unitPrice: 2000.25 },
        ],
        subtotal: 3200.5,
        tax: 0,
        total: 3200.5,
        currency: "AUD",
        validUntil: "2026-08-30",
        notes: "Read-only inspection fixture.",
        termsIncluded: true,
        createdAt: 10,
        updatedAt: 20,
      },
    };
    const calls: Array<{ name: string; args: Record<string, unknown> }> = [];
    const state: Record<string, unknown> = {
      selectedQuoteSummary: null,
      selectedQuote: null,
      quoteDetailState: "empty",
    };
    let renders = 0;
    const callTool = async (name: string, args: Record<string, unknown>) => {
      calls.push({ name, args });
      return { quote: SNAPSHOT };
    };
    const openQuote = new Function(
      "state",
      "callTool",
      "renderQuoteDetail",
      `"use strict"; ${openSource}; return openQuote;`,
    )(state, callTool, () => {
      renders += 1;
    }) as (summary: { id?: string; quoteId: string; number: string }) => Promise<void>;

    await openQuote({
      id: "legacy-quote-174",
      quoteId: "quote / 174",
      number: "174",
    });

    assert.deepEqual(calls, [
      { name: "get_quote", args: { quoteId: "quote / 174" } },
    ]);
    assert.equal(state.quoteDetailState, "ready");
    assert.deepEqual(state.selectedQuote, SNAPSHOT);
    assert.equal(renders, 2);

    const elements = new Map<string, { id: string; textContent: string; hidden: boolean }>();
    const lists = new Map<string, unknown[]>();
    const byId = (id: string) => {
      const existing = elements.get(id);
      if (existing) return existing;
      const element = { id, textContent: "", hidden: false };
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
    const renderQuoteDetail = new Function(
      "state",
      "byId",
      "text",
      "fillList",
      "operationsRow",
      "empty",
      "aud",
      `"use strict"; ${renderSource}; renderQuoteDetail();`,
    );
    renderQuoteDetail(state, byId, text, fillList, () => ({}), () => ({}), {
      format: (value: number) =>
        new Intl.NumberFormat("en-AU", {
          style: "currency",
          currency: "AUD",
          minimumFractionDigits: 2,
          maximumFractionDigits: 2,
        }).format(value),
    });

    assert.equal(elements.get("quote-detail-total")?.textContent, "$3,200.50");
    assert.equal(elements.get("quote-detail-number")?.textContent, "#174");
    assert.deepEqual(lists.get("quote-detail-items"), SNAPSHOT.revision.lineItems);
  });

  it("keeps the newest same-quote inspection result", async () => {
    const openSource = widget.match(
      /(async function openQuote\(summary\) \{[\s\S]*?\})\n\s+function renderQuoteDetail/,
    )?.[1];
    assert.ok(openSource, "quote selection handler was not found");

    type Resolver = (value: unknown) => void;
    const resolvers: Resolver[] = [];
    const state: Record<string, unknown> = {
      selectedQuoteSummary: null,
      selectedQuote: null,
      quoteDetailState: "empty",
      quoteRequestGeneration: 0,
    };
    const callTool = () =>
      new Promise((resolve) => {
        resolvers.push(resolve);
      });
    const openQuote = new Function(
      "state",
      "callTool",
      "renderQuoteDetail",
      `"use strict"; ${openSource}; return openQuote;`,
    )(state, callTool, () => {}) as (summary: {
      quoteId: string;
      number: string;
    }) => Promise<void>;

    const summary = { quoteId: "lifecycle-174", number: "174" };
    const first = openQuote(summary);
    const second = openQuote(summary);
    const newest = {
      aggregate: { quoteId: summary.quoteId, number: "174" },
      revision: { revision: 2, lineItems: [], total: 200 },
    };
    const stale = {
      aggregate: { quoteId: summary.quoteId, number: "174" },
      revision: { revision: 1, lineItems: [], total: 100 },
    };

    resolvers[1]?.({ quote: newest });
    await second;
    resolvers[0]?.({ quote: stale });
    await first;

    assert.deepEqual(state.selectedQuote, newest);
    assert.equal(state.quoteDetailState, "ready");
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
