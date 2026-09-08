import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { describe, it } from "node:test";

const widget = readFileSync(new URL("../src/mcp/dashboard-v1.html", import.meta.url), "utf8");

type Element = {
  id?: string;
  className: string;
  textContent: string;
  children: Element[];
  classList: {
    add(...names: string[]): void;
    remove(...names: string[]): void;
    toggle(name: string, force?: boolean): void;
  };
  setAttribute(name: string, value: string): void;
  append(...items: Element[]): void;
  replaceChildren(): void;
};

function makeElement(id?: string): Element {
  const classes = new Set<string>();
  const element: Element = {
    id,
    className: "",
    textContent: "",
    children: [],
    classList: {
      add: (...names) => names.forEach((name) => classes.add(name)),
      remove: (...names) => names.forEach((name) => classes.delete(name)),
      toggle: (name, force) => {
        const shouldAdd = force ?? !classes.has(name);
        if (shouldAdd) classes.add(name);
        else classes.delete(name);
      },
    },
    setAttribute: (_name, _value) => {},
    append(...items: Element[]) {
      element.children.push(...items);
    },
    replaceChildren() {
      element.children = [];
    },
  };
  return element;
}

function flattenText(element: Element): string {
  return [element.textContent, ...element.children.map(flattenText)].filter(Boolean).join(" ");
}

function harness() {
  const registry = new Map<string, Element>();
  const byId = (id: string) => {
    const existing = registry.get(id);
    if (existing) return existing;
    const element = makeElement(id);
    registry.set(id, element);
    return element;
  };
  const text = (element: Element, value: unknown) => {
    element.textContent = value == null ? "" : String(value);
  };
  const fillList = (
    element: Element,
    items: unknown[],
    renderer: (item: unknown) => Element,
    message: string,
  ) => {
    element.replaceChildren();
    if (!items.length) {
      const emptyEl = makeElement();
      emptyEl.textContent = message;
      element.append(emptyEl);
      return;
    }
    items.forEach((item) => element.append(renderer(item)));
  };
  const empty = (message: string) => {
    const el = makeElement();
    el.textContent = message;
    return el;
  };
  const documentStub = {
    createElement: (_tag: string) => makeElement(),
  };
  return { registry, byId, text, fillList, empty, documentStub };
}

function extractSource(pattern: RegExp): string {
  const match = widget.match(pattern)?.[1];
  assert.ok(match, `pattern not found: ${pattern}`);
  return match;
}

describe("Operations inbox / activity timeline / integration health HUD wiring", () => {
  const inboxSource = extractSource(
    /(function inboxHasDegradedSource\(inbox\)[\s\S]*?function renderActivityTimeline\(\) \{[\s\S]*?\})\n\s+function renderCounts/,
  );

  function runInboxRenderers(state: unknown, h: ReturnType<typeof harness>) {
    const run = new Function(
      "document",
      "state",
      "byId",
      "text",
      "fillList",
      "empty",
      `"use strict"; ${inboxSource}; renderInbox(); renderActivityTimeline();`,
    );
    run(h.documentStub, state, h.byId, h.text, h.fillList, h.empty);
  }

  it("renders inbox items and never claims a degraded source is healthy", () => {
    const h = harness();
    const state = {
      inbox: {
        generatedAt: "2026-07-30T12:00:00.000Z",
        items: [
          {
            itemId: "maintenance-overdue:asset-1",
            kind: "maintenance-overdue",
            severity: "elevated",
            title: "Bandsaw",
            explanation: "Service was due and has not been recorded since.",
          },
        ],
        sources: [
          { source: "reminders", status: "available", checkedAt: "2026-07-30T12:00:00.000Z" },
          {
            source: "toolActions",
            status: "unsupported",
            reason: "Not yet wired.",
            checkedAt: "2026-07-30T12:00:00.000Z",
          },
        ],
      },
      activity: null,
    };

    runInboxRenderers(state, h);

    assert.equal(h.registry.get("inbox-summary")?.textContent, "1 ITEM NEEDS ATTENTION");
    const itemList = h.registry.get("inbox-item-list")!;
    assert.equal(itemList.children.length, 1);
    const sourceList = h.registry.get("inbox-source-list")!;
    assert.equal(sourceList.children.length, 2);
  });

  it("reports the inbox as unavailable rather than an empty list when the fetch itself failed", () => {
    const h = harness();
    const state = { inbox: null, activity: null };

    runInboxRenderers(state, h);

    assert.equal(h.registry.get("inbox-summary")?.textContent, "INBOX UNAVAILABLE");
    const itemList = h.registry.get("inbox-item-list")!;
    assert.equal(itemList.children.length, 1);
    assert.match(itemList.children[0]!.textContent, /could not be reached/i);
  });

  it("never reports 'nothing needs attention' when a source is unavailable or degraded", () => {
    const h = harness();
    const state = {
      inbox: {
        generatedAt: "2026-07-30T12:00:00.000Z",
        items: [],
        sources: [
          {
            source: "reminders",
            status: "unavailable",
            reason: "offline",
            checkedAt: "2026-07-30T12:00:00.000Z",
          },
        ],
      },
      activity: null,
    };

    runInboxRenderers(state, h);

    const summary = h.registry.get("inbox-summary")?.textContent ?? "";
    assert.doesNotMatch(summary, /nothing needs attention/i);
    // The item-list's own empty-state placeholder is a separate render path
    // from the summary header — both must honour the same invariant.
    const itemListMessage = h.registry.get("inbox-item-list")!.children[0]!.textContent;
    assert.doesNotMatch(itemListMessage, /nothing needs attention/i);
    assert.match(itemListMessage, /available sources/i);
  });

  it("renders inbox item text via textContent, never as parsed markup (hostile-text safety)", () => {
    const h = harness();
    const hostile = '<img src=x onerror="alert(1)">';
    const state = {
      inbox: {
        generatedAt: "2026-07-30T12:00:00.000Z",
        items: [
          {
            itemId: "x",
            kind: "reminder-overdue",
            severity: "normal",
            title: hostile,
            explanation: hostile,
          },
        ],
        sources: [],
      },
      activity: null,
    };

    runInboxRenderers(state, h);

    const itemList = h.registry.get("inbox-item-list")!;
    const row = itemList.children[0]!;
    // The title/explanation text must appear as plain textContent on child
    // elements — never concatenated into innerHTML anywhere in the render path.
    assert.match(flattenText(row), /alert\(1\)/); // present as inert text...
    assert.doesNotMatch(widget, /\.innerHTML\s*=/); // ...and the widget never uses innerHTML at all.
  });

  it("surfaces activity-timeline unavailability truthfully, distinct from an empty durable feed", () => {
    const h = harness();
    const unavailable = {
      inbox: null,
      activity: {
        status: "unavailable",
        reason: "Requires the configured Convex persistence provider.",
      },
    };
    runInboxRenderers(unavailable, h);
    assert.match(h.registry.get("activity-timeline-status")?.textContent ?? "", /UNAVAILABLE/);
    assert.match(
      h.registry.get("activity-timeline-list")!.children[0]!.textContent,
      /Requires the configured Convex persistence provider\./,
    );

    const h2 = harness();
    const empty = {
      inbox: null,
      activity: { status: "available", events: [], cursor: "", isDone: true },
    };
    runInboxRenderers(empty, h2);
    assert.match(h2.registry.get("activity-timeline-status")?.textContent ?? "", /0 EVENTS/);
    assert.match(
      h2.registry.get("activity-timeline-list")!.children[0]!.textContent,
      /No recent activity/i,
    );
  });

  it("renders durable activity events using the source's own timestamp, not render time", () => {
    const h = harness();
    const state = {
      inbox: null,
      activity: {
        status: "available",
        events: [
          {
            activityId: "audit-1",
            occurredAt: "2020-01-01T00:00:00.000Z",
            eventType: "tool.action.approved",
            actor: "user",
            summary: "Tool action action-1 approved.",
          },
        ],
        cursor: "",
        isDone: true,
      },
    };

    runInboxRenderers(state, h);

    const row = h.registry.get("activity-timeline-list")!.children[0]!;
    assert.match(flattenText(row), /Tool action action-1 approved\./);
  });
});

describe("Integration commissioning HUD wiring", () => {
  const systemsSource = extractSource(
    /(function renderSystems\(\) \{[\s\S]*?\})\n\s+function renderCategories/,
  );

  function runRenderSystems(state: unknown, h: ReturnType<typeof harness>) {
    const run = new Function(
      "document",
      "state",
      "byId",
      "text",
      "renderReadiness",
      "renderRadar",
      `"use strict"; ${systemsSource}; renderSystems();`,
    );
    run(
      h.documentStub,
      state,
      h.byId,
      h.text,
      () => {},
      () => {},
    );
  }

  it("renders commissioned and not-commissioned integrations without fabricating a percentage", () => {
    const h = harness();
    const state = {
      status: {
        status: "ok",
        zState: "disabled",
        sourceVersion: "test",
        timezone: "Australia/Melbourne",
        provider: { name: "convex", reachability: "ok" },
        layers: {},
        integrations: [
          {
            name: "quote-delivery",
            status: "not-commissioned",
            reason: "quotes:send not registered",
          },
        ],
      },
    };

    runRenderSystems(state, h);

    const grid = h.registry.get("integration-grid")!;
    assert.equal(grid.children.length, 1);
    const values = grid.children[0]!.children.map((child) => child.textContent);
    assert.deepEqual(values, ["quote-delivery", "NOT-COMMISSIONED"]);
  });

  it("clears the integration grid while status is still connecting", () => {
    const h = harness();
    // Pre-populate as if a previous render had items, to prove the "no status
    // yet" branch actively clears rather than leaving stale content.
    const grid = h.byId("integration-grid");
    grid.append(makeElement());

    runRenderSystems({ status: null }, h);

    assert.equal(h.registry.get("integration-grid")!.children.length, 0);
  });

  it("clears stale runtime health while connecting and restores it with the next status payload", () => {
    const h = harness();
    const configured = {
      status: {
        status: "ok",
        checkedAt: "2026-08-01T04:05:06.000Z",
        zState: "disabled",
        provider: {
          name: "convex",
          reachability: "ok",
          deploymentVersion: "dev-one",
          authentication: "ok",
          schemaCompatibility: "ok",
        },
        sourceVersion: "source-one",
        timezone: "Australia/Melbourne",
        layers: { runtime: { status: "ok" } },
        integrations: [],
      },
    };
    const expectedCheckedAt = new Date(configured.status.checkedAt).toLocaleTimeString("en-AU");

    runRenderSystems(configured, h);
    assert.equal(h.registry.get("system-status")?.textContent, "OK");
    assert.equal(h.registry.get("checked-at")?.textContent, expectedCheckedAt);
    assert.equal(h.registry.get("z-state")?.textContent, "DISABLED");
    assert.equal(h.registry.get("provider")?.textContent, "convex · ok");
    assert.equal(h.registry.get("deployment")?.textContent, "dev-one");
    assert.equal(h.registry.get("source-version")?.textContent, "source-one");
    assert.equal(h.registry.get("timezone")?.textContent, "Australia/Melbourne");
    assert.equal(h.registry.get("layer-grid")?.children.length, 1);
    assert.equal(flattenText(h.registry.get("layer-grid")!), "runtime ok");
    assert.equal(h.registry.get("right-provider")?.textContent, "convex PERSISTENCE");
    assert.equal(h.registry.get("provider-reachability")?.textContent, "OK");
    assert.equal(h.registry.get("provider-authentication")?.textContent, "OK");
    assert.equal(h.registry.get("provider-schema")?.textContent, "OK");
    assert.equal(h.registry.get("provider-version")?.textContent, "dev-one");
    assert.equal(h.registry.get("provider-link-state")?.textContent, "LINK ONLINE");
    assert.equal(h.registry.get("telemetry-provider")?.textContent, "CONVEX");
    assert.equal(h.registry.get("telemetry-deployment")?.textContent, "dev-one");
    assert.equal(h.registry.get("telemetry-z-state")?.textContent, "DISABLED");
    assert.equal(h.registry.get("source-pill")?.textContent, "SOURCE · source-one");
    assert.equal(h.registry.get("footer-status")?.textContent, "Jarvis ok · convex persistence");

    runRenderSystems({ status: null }, h);
    assert.equal(h.registry.get("status-label")?.textContent, "CONNECTING");
    for (const id of [
      "system-status",
      "z-state",
      "provider",
      "deployment",
      "source-version",
      "timezone",
      "right-provider",
      "provider-reachability",
      "provider-authentication",
      "provider-schema",
      "provider-version",
      "telemetry-provider",
      "telemetry-deployment",
      "telemetry-z-state",
    ]) {
      assert.equal(h.registry.get(id)?.textContent, "UNAVAILABLE", id);
    }
    assert.equal(h.registry.get("checked-at")?.textContent, "");
    assert.equal(h.registry.get("layer-grid")?.children.length, 0);
    assert.equal(h.registry.get("provider-link-state")?.textContent, "CONNECTING");
    assert.equal(h.registry.get("source-pill")?.textContent, "SOURCE · CONNECTING");
    assert.equal(
      h.registry.get("footer-status")?.textContent,
      "Jarvis reconnecting · status unavailable",
    );

    const restored = {
      status: {
        ...configured.status,
        status: "degraded",
        checkedAt: "2026-08-01T05:06:07.000Z",
        provider: {
          name: "convex",
          reachability: "unavailable",
          deploymentVersion: "dev-two",
          authentication: "failed",
          schemaCompatibility: "unknown",
        },
        sourceVersion: "source-two",
        timezone: "UTC",
        layers: { storage: { status: "degraded" } },
      },
    };
    runRenderSystems(restored, h);
    assert.equal(h.registry.get("status-label")?.textContent, "DEGRADED");
    assert.equal(h.registry.get("system-status")?.textContent, "DEGRADED");
    assert.equal(
      h.registry.get("checked-at")?.textContent,
      new Date(restored.status.checkedAt).toLocaleTimeString("en-AU"),
    );
    assert.equal(h.registry.get("z-state")?.textContent, "DISABLED");
    assert.equal(h.registry.get("provider")?.textContent, "convex · unavailable");
    assert.equal(h.registry.get("deployment")?.textContent, "dev-two");
    assert.equal(h.registry.get("source-version")?.textContent, "source-two");
    assert.equal(h.registry.get("timezone")?.textContent, "UTC");
    assert.equal(h.registry.get("layer-grid")?.children.length, 1);
    assert.equal(flattenText(h.registry.get("layer-grid")!), "storage degraded");
    assert.equal(h.registry.get("right-provider")?.textContent, "convex PERSISTENCE");
    assert.equal(h.registry.get("provider-reachability")?.textContent, "UNAVAILABLE");
    assert.equal(h.registry.get("provider-authentication")?.textContent, "FAILED");
    assert.equal(h.registry.get("provider-schema")?.textContent, "UNKNOWN");
    assert.equal(h.registry.get("provider-version")?.textContent, "dev-two");
    assert.equal(h.registry.get("provider-link-state")?.textContent, "LINK DEGRADED");
    assert.equal(h.registry.get("telemetry-provider")?.textContent, "CONVEX");
    assert.equal(h.registry.get("telemetry-deployment")?.textContent, "dev-two");
    assert.equal(h.registry.get("telemetry-z-state")?.textContent, "DISABLED");
    assert.equal(h.registry.get("source-pill")?.textContent, "SOURCE · source-two");
    assert.equal(
      h.registry.get("footer-status")?.textContent,
      "Jarvis degraded · convex persistence",
    );
  });

  it("keeps persistence reachability distinct from authentication and schema status", () => {
    const h = harness();
    runRenderSystems(
      {
        status: {
          status: "degraded",
          zState: "disabled",
          provider: {
            name: "convex",
            reachability: "ok",
            authentication: "failed",
            schemaCompatibility: "unknown",
          },
          layers: {},
          integrations: [],
        },
      },
      h,
    );

    assert.equal(h.registry.get("status-label")?.textContent, "DEGRADED");
    assert.equal(h.registry.get("provider-reachability")?.textContent, "OK");
    assert.equal(h.registry.get("provider-authentication")?.textContent, "FAILED");
    assert.equal(h.registry.get("provider-schema")?.textContent, "UNKNOWN");
    assert.equal(h.registry.get("reasoning-provider")?.textContent, "NOT CONFIGURED");
  });

  it("renders the reasoning provider/model with a configuration-only, invocation-unverified caveat", () => {
    const h = harness();
    const state = {
      status: {
        status: "ok",
        zState: "disabled",
        sourceVersion: "test",
        timezone: "Australia/Melbourne",
        provider: { name: "convex", reachability: "ok" },
        layers: {},
        integrations: [],
        reasoning: {
          status: "configured",
          provider: "openai",
          model: "gpt-5.6",
          reason:
            "Configuration only -- invocation has not been verified with a live provider call.",
        },
      },
    };

    runRenderSystems(state, h);

    assert.equal(h.registry.get("reasoning-provider")?.textContent, "openai · gpt-5.6");
    assert.equal(
      h.registry.get("reasoning-verification")?.textContent,
      "CONFIGURATION ONLY / INVOCATION UNVERIFIED",
    );
  });

  it("clears stale reasoning identity while connecting and restores it afterward", () => {
    const h = harness();
    const configured = {
      status: {
        status: "ok",
        zState: "disabled",
        provider: { name: "convex", reachability: "ok" },
        layers: {},
        integrations: [],
        reasoning: { status: "configured", provider: "openai", model: "gpt-5.6" },
      },
    };

    runRenderSystems(configured, h);
    assert.equal(h.registry.get("reasoning-provider")?.textContent, "openai · gpt-5.6");

    runRenderSystems({ status: null }, h);
    assert.equal(h.registry.get("reasoning-provider")?.textContent, "UNAVAILABLE");
    assert.equal(h.registry.get("reasoning-verification")?.textContent, "WAITING FOR STATUS");

    runRenderSystems(configured, h);
    assert.equal(h.registry.get("reasoning-provider")?.textContent, "openai · gpt-5.6");
    assert.equal(
      h.registry.get("reasoning-verification")?.textContent,
      "CONFIGURATION ONLY / INVOCATION UNVERIFIED",
    );
  });

  it("never claims a configured reasoning provider when none is set up", () => {
    const h = harness();
    const state = {
      status: {
        status: "ok",
        zState: "disabled",
        sourceVersion: "test",
        timezone: "Australia/Melbourne",
        provider: { name: "json", reachability: "ok" },
        layers: {},
        integrations: [],
        reasoning: {
          status: "not-configured",
          provider: null,
          model: null,
          reason:
            "Totality reasoning requires Convex persistence, which is not the active provider.",
        },
      },
    };

    runRenderSystems(state, h);

    assert.equal(h.registry.get("reasoning-provider")?.textContent, "NOT CONFIGURED");
    assert.equal(h.registry.get("reasoning-verification")?.textContent, "NOT CONFIGURED");
  });
});
