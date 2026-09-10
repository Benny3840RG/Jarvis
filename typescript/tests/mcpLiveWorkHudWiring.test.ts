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

describe("Live Work HUD runtime wiring", () => {
  function render(liveWork: unknown) {
    const h = harness();
    const source = extractSource(/(const LIVE_WORK_KEYS =[\s\S]*?)\n\s+function render\(\)/);
    const eventSource = extractSource(/(function activityEventRow\(event\)[^\n]*)/);
    new Function(
      "document",
      "state",
      "byId",
      "text",
      "fillList",
      "empty",
      `${eventSource}; ${source}; renderLiveWork();`,
    )(h.documentStub, { liveWork }, h.byId, h.text, h.fillList, h.empty);
    return h;
  }
  function pipeline(state: string, allowed = false) {
    return {
      status: "ready",
      pipeline: {
        objective: "<script>mission</script>",
        subjectId: "mission-1",
        repository: "owner/repo",
        branch: "work",
        state,
        completionLabel:
          state === "MERGED" ? `MERGED — ΩΣ ${allowed ? "READY" : "NOT READY"}` : state,
        missionInFlight: state !== "COMPLETE",
        subjectVersion: 12,
        orchestrationRunId: "run-1",
        orchestrationNodeId: "node-1",
        fencingToken: 7,
        omegaReadiness: { allowed, failures: allowed ? [] : ["Completion evidence missing"] },
        rail: [
          { state: "IDEA", label: "MISSION", status: "done" },
          {
            state,
            label: state === "COMPLETE" ? "ΩΣ" : state,
            status: state === "COMPLETE" ? "done" : "active",
          },
        ],
        nodes: [{ key: "worker", status: "active", detail: "Worker lease active" }],
        events: [{ summary: "Persisted transition", at: "2026-09-11T00:00:00Z" }],
      },
    };
  }
  it("clears the rail for unavailable and idle responses", () => {
    for (const [value, label] of [
      [null, "OFFLINE"],
      [{ status: "unavailable", reason: "Store unavailable" }, "UNAVAILABLE"],
      [{ status: "ready", pipeline: null }, "IDLE"],
    ] as const) {
      const h = render(value);
      assert.equal(h.byId("livework-state").textContent, label);
      assert.equal(h.byId("livework-pipeline").children.length, 1);
      assert.equal(h.byId("nav-livework-count").textContent, "0");
    }
  });
  for (const state of ["BUILDING", "REPAIR_REQUIRED", "INDETERMINATE", "COMPLETE"]) {
    it(`renders the server rail and persisted ${state} state`, () => {
      const data = pipeline(state);
      const h = render(data);
      assert.equal(h.byId("livework-state").textContent, state);
      assert.equal(h.byId("livework-pipeline").children.length, 2);
      assert.equal(
        flattenText(h.byId("livework-pipeline")).includes(state === "COMPLETE" ? "ΩΣ" : state),
        true,
      );
      assert.equal(h.byId("livework-objective").textContent, "<script>mission</script>");
      assert.match(flattenText(h.byId("livework-events")), /Persisted transition/);
      assert.match(h.byId("livework-bindings").textContent, /12.*run-1.*node-1.*7/);
      assert.equal(h.byId("lw-detail-worker").textContent, "Worker lease active");
    });
  }
  for (const allowed of [false, true]) {
    it(`keeps merged ΩΣ readiness ${allowed} distinct from completion`, () => {
      const h = render(pipeline("MERGED", allowed));
      assert.equal(
        h.byId("livework-state").textContent,
        `MERGED — ΩΣ ${allowed ? "READY" : "NOT READY"}`,
      );
      assert.doesNotMatch(flattenText(h.byId("livework-pipeline")), /COMPLETE/);
      assert.equal(h.byId("nav-livework-count").textContent, "1");
      assert.match(
        flattenText(h.byId("livework-omega-failures")),
        allowed ? /No readiness failures/ : /Completion evidence missing/,
      );
    });
  }
});

it("renders one mission mascot without duplicated overlay effects", () => {
  assert.equal((widget.match(/class="mission-mascot"/g) ?? []).length, 1);
});
