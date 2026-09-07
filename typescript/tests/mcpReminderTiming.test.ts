import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { describe, it } from "node:test";

const widget = readFileSync(new URL("../src/mcp/dashboard-v1.html", import.meta.url), "utf8");

type Element = {
  textContent: string;
  children: Element[];
  className: string;
  setAttribute(name: string, value: string): void;
  append(...items: Element[]): void;
  replaceChildren(): void;
};

function makeElement(): Element {
  const element: Element = {
    textContent: "",
    children: [],
    className: "",
    setAttribute: () => {},
    append(...items) {
      element.children.push(...items);
    },
    replaceChildren() {
      element.children = [];
    },
  };
  return element;
}

function harness() {
  const elements = new Map<string, Element>();
  const byId = (id: string) => {
    const existing = elements.get(id);
    if (existing) return existing;
    const element = makeElement();
    elements.set(id, element);
    return element;
  };
  const documentStub = {
    createElement: () => makeElement(),
    createElementNS: () => makeElement(),
  };
  const text = (element: Element, value: unknown) => {
    element.textContent = value == null ? "" : String(value);
  };
  const empty = (message: string) => {
    const element = makeElement();
    element.textContent = message;
    return element;
  };
  const fillList = (
    element: Element,
    items: Reminder[],
    renderer: (item: Reminder) => Element,
    message: string,
  ) => {
    element.replaceChildren();
    if (!items.length) element.append(empty(message));
    else items.forEach((item) => element.append(renderer(item)));
  };
  return { byId, documentStub, elements, empty, fillList, text };
}

type Reminder = { title: string; dueAt?: number | null; dueRaw?: string };

function extractSource(pattern: RegExp): string {
  const match = widget.match(pattern)?.[1];
  assert.ok(match, `pattern not found: ${pattern}`);
  return match;
}

const reminderSource = [
  extractSource(/(^\s*const reminderTime = .*;$)/m),
  // Older renderers sort inline. Permit their missing helper so regression
  // checks fail on real behaviour, rather than on a newly introduced symbol.
  widget.match(/(^\s*const reminderDue = .*;$)/m)?.[1] ?? "",
  extractSource(/(^\s*function reminderRow\(reminder\).*\})$/m),
  extractSource(/(^\s*function timingBuckets\(\).*\})$/m),
  extractSource(/(^\s*function renderReminderChart\(\).*\})$/m),
  extractSource(/(^\s*function renderReminders\(\).*\})$/m),
  extractSource(/(^\s*function renderRightReminders\(\).*\})$/m),
].join("\n");

function run(state: { reminders: Reminder[] }, now: number) {
  const h = harness();
  const implementation = new Function(
    "document",
    "state",
    "byId",
    "text",
    "empty",
    "fillList",
    "Date",
    `"use strict"; ${reminderSource}; return { timingBuckets, renderReminders, renderRightReminders };`,
  ) as (...args: unknown[]) => {
    timingBuckets: () => number[];
    renderReminders: () => void;
    renderRightReminders: () => void;
  };
  class FixedDate extends Date {
    static now = () => now;
  }
  const functions = implementation(
    h.documentStub,
    state,
    h.byId,
    h.text,
    h.empty,
    h.fillList,
    FixedDate,
  );
  return { ...h, ...functions };
}

describe("HUD reminder timing", () => {
  it("keeps zero dueAt timed, overdue, displayed, and sorted before open reminders", () => {
    const reminders: Reminder[] = [
      { title: "Later", dueAt: 2000 },
      { title: "Open" },
      { title: "Epoch", dueAt: 0 },
    ];
    const original = reminders.slice();
    const h = run({ reminders }, 1000);

    assert.deepEqual(h.timingBuckets(), [1, 1, 0, 1]);
    h.renderReminders();
    h.renderRightReminders();

    const fullList = h.elements.get("reminder-list")!;
    assert.deepEqual(
      fullList.children.map((row) => row.children[0]!.children[0]!.textContent),
      ["Epoch", "Later", "Open"],
    );
    assert.equal(fullList.children[0]!.children[1]!.textContent, "TIMED");
    assert.equal(
      fullList.children[0]!.children[0]!.children[1]!.textContent,
      new Date(0).toLocaleString("en-AU"),
    );
    assert.equal(
      fullList.children[1]!.children[0]!.children[1]!.textContent,
      new Date(2000).toLocaleString("en-AU"),
    );

    const rightList = h.elements.get("right-reminder-list")!;
    assert.deepEqual(
      rightList.children.map((row) => row.children[0]!.textContent),
      ["Epoch", "Later", "Open"],
    );
    assert.deepEqual(reminders, original);
  });

  it("keeps missing dates open, undated, and last", () => {
    const reminders: Reminder[] = [{ title: "Open" }, { title: "Epoch", dueAt: 0 }];
    const h = run({ reminders }, 1000);

    h.renderReminders();

    const list = h.elements.get("reminder-list")!;
    assert.equal(list.children[1]!.children[1]!.textContent, "OPEN");
    assert.equal(list.children[1]!.children[0]!.children[1]!.textContent, "No due time");
    assert.equal(list.children[0]!.children[0]!.children[0]!.textContent, "Epoch");
  });

  it("keeps dueRaw display precedence for zero and ordinary timestamps", () => {
    const h = run(
      {
        reminders: [
          { title: "Epoch", dueAt: 0, dueRaw: "Original epoch wording" },
          { title: "Later", dueAt: 2000, dueRaw: "After lunch" },
        ],
      },
      1000,
    );
    h.renderReminders();
    h.renderRightReminders();
    assert.deepEqual(
      h.byId("reminder-list").children.map((row) => row.children[0]!.children[1]!.textContent),
      ["Original epoch wording", "After lunch"],
    );
    assert.deepEqual(
      h.byId("right-reminder-list").children.map((row) => row.children[1]!.textContent),
      ["Original epoch wording", "After lunch"],
    );
  });

  it("sorts before taking the three-item right list without mutating input", () => {
    const reminders: Reminder[] = [
      { title: "Missing" },
      { title: "Null", dueAt: null },
      { title: "Far", dueAt: 3000 },
      { title: "Later", dueAt: 2000 },
      { title: "Epoch", dueAt: 0 },
    ];
    const original = structuredClone(reminders);
    const h = run({ reminders }, 1000);
    h.renderReminders();
    h.renderRightReminders();
    assert.deepEqual(h.timingBuckets(), [1, 2, 0, 2]);
    assert.deepEqual(
      h.byId("reminder-list").children.map((row) => row.children[0]!.children[0]!.textContent),
      ["Epoch", "Later", "Far", "Missing", "Null"],
    );
    assert.deepEqual(
      h.byId("right-reminder-list").children.map((row) => row.children[0]!.textContent),
      ["Epoch", "Later", "Far"],
    );
    assert.equal(h.byId("reminder-list").children[4]!.children[1]!.textContent, "OPEN");
    assert.equal(
      h.byId("reminder-list").children[4]!.children[0]!.children[1]!.textContent,
      "No due time",
    );
    assert.deepEqual(reminders, original);
  });
});
