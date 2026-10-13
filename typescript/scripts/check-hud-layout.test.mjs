import assert from "node:assert/strict";
import test from "node:test";
import { readFileSync } from "node:fs";
import { runInNewContext } from "node:vm";
import {
  assessVisibility,
  assessNoOverlap,
  fixtureFor,
  parseArgs,
  measureElement,
  responseForRequest,
  browserError,
} from "./check-hud-layout.mjs";

const rect = (left, top, right, bottom) => ({ left, top, right, bottom });
const measurement = (overrides = {}) => ({
  label: "Next 3 title",
  rects: [rect(10, 10, 70, 24)],
  clips: [{ label: "viewport", ...rect(0, 0, 1920, 1080) }],
  hidden: [],
  occluded: [],
  ...overrides,
});

test("accepts visible text inside all clipping bounds", () => {
  assert.deepEqual(assessVisibility(measurement()), []);
});

test("rejects partial clipping even when a text center remains visible", () => {
  const errors = assessVisibility(
    measurement({ clips: [{ label: ".queue-panel", ...rect(0, 0, 100, 20) }] }),
  );
  assert.equal(errors.length, 1);
  assert.match(errors[0], /Next 3 title.*clipped.*queue-panel/);
});

test("rejects the third task below an overflowing ancestor", () => {
  const errors = assessVisibility(
    measurement({
      rects: [rect(10, 45, 70, 59)],
      clips: [{ label: ".now-strip", ...rect(0, 0, 100, 26) }],
    }),
  );
  assert.match(errors[0], /clipped.*now-strip/);
});

test("checks every wrapped line and horizontal clipping", () => {
  assert.equal(
    assessVisibility(
      measurement({
        rects: [rect(10, 10, 70, 24), rect(10, 25, 105, 39)],
        clips: [{ label: "panel", ...rect(0, 0, 100, 50) }],
      }),
    ).length,
    1,
  );
});

test("rejects hidden, missing and covered content", () => {
  assert.match(assessVisibility(measurement({ hidden: ["display:none"] }))[0], /hidden/);
  assert.match(assessVisibility(measurement({ rects: [] }))[0], /no rendered/);
  assert.match(assessVisibility(measurement({ occluded: ["button is covered"] }))[0], /covered/);
});

test("allows only subpixel rounding tolerance", () => {
  assert.deepEqual(assessVisibility(measurement({ rects: [rect(-0.1, 10, 70, 24)] })), []);
  assert.notDeepEqual(assessVisibility(measurement({ rects: [rect(-1, 10, 70, 24)] })), []);
});

test("fixtures are deterministic, synthetic, and include Now plus all three next tasks", () => {
  assert.equal(fixtureFor("empty").tasks.length, 0);
  const populated = fixtureFor("populated");
  assert.equal(populated.tasks.length, 4);
  assert.ok(populated.tasks.every((task) => task.title.startsWith("[TEST ONLY]")));
  assert.deepEqual(populated, fixtureFor("populated"));
  assert.throws(() => fixtureFor("live"), /Unknown fixture/);
});

test("accepts an immutable HTML path and rejects unknown or incomplete options", () => {
  assert.equal(parseArgs(["--html", "/tmp/baseline.html"]).html, "/tmp/baseline.html");
  assert.equal(parseArgs(["--output-dir", "/tmp/evidence"]).outputDir, "/tmp/evidence");
  assert.throws(() => parseArgs(["--skip-browser"]), /Unknown/);
  assert.throws(() => parseArgs(["--html"]), /requires a value/);
});

test("rejects tactical labels overlapping their heading", () => {
  const label = measurement({ label: "tactical label", rects: [rect(10, 10, 70, 24)] });
  const heading = measurement({ label: "tactical heading", rects: [rect(10, 20, 90, 35)] });
  assert.match(assessNoOverlap(label, heading)[0], /overlaps/);
  assert.deepEqual(assessNoOverlap(label, { ...heading, rects: [rect(10, 25, 90, 40)] }), []);
});

test("tactical fixtures use six bounded labels long enough to exercise scrolling", () => {
  const items = fixtureFor("populated").inbox.items;
  assert.equal(items.length, 6);
  assert.ok(items.every((item) => item.title.startsWith("[TEST ONLY]")));
  assert.ok(items.every((item) => item.title.length >= 60 && item.title.length <= 90));
});

test("display:contents ancestors do not produce fictional zero-sized clipping boxes", () => {
  const style = {
    display: "block",
    visibility: "visible",
    opacity: "1",
    clip: "auto",
    overflowX: "visible",
    overflowY: "visible",
  };
  const parent = {
    tagName: "DIV",
    classList: ["core-side"],
    getBoundingClientRect: () => ({ ...rect(0, 0, 0, 0), width: 0, height: 0 }),
    clientLeft: 0,
    clientTop: 0,
    clientWidth: 0,
    clientHeight: 0,
    parentElement: null,
  };
  const element = {
    tagName: "SPAN",
    classList: [],
    textContent: "test",
    getBoundingClientRect: () => ({ ...rect(10, 10, 70, 24), width: 60, height: 14 }),
    parentElement: parent,
  };
  const measure = (display) =>
    runInNewContext(`(${measureElement.toString()})(".label", {text:false,hitTest:false})`, {
      document: { querySelector: () => element },
      innerWidth: 1920,
      innerHeight: 1080,
      getComputedStyle: (target) =>
        target === parent ? { ...style, display, overflowX: "hidden", overflowY: "hidden" } : style,
    });
  assert.equal(assessVisibility(measure("contents")).length, 0);
  assert.ok(assessVisibility(measure("block")).some((failure) => failure.includes("clipped")));
});

test("inbox fixtures execute the actual dashboard inbox renderer", () => {
  const source = readFileSync(new URL("../src/mcp/dashboard-v1.html", import.meta.url), "utf8");
  const match = source.match(
    /(function inboxHasDegradedSource\(inbox\)[\s\S]*?function renderInbox\(\) \{[^\n]+\})/,
  );
  assert.ok(match);
  const element = () => ({ append() {}, replaceChildren() {} });
  for (const name of ["empty", "populated"]) {
    assert.doesNotThrow(() =>
      runInNewContext(`${match[1]}; renderInbox()`, {
        state: fixtureFor(name),
        document: { createElement: element },
        byId: element,
        text(target, value) {
          target.textContent = value;
        },
        empty: element,
        fillList(target, items, render) {
          items.forEach(render);
        },
      }),
    );
  }
});

test("only the expected read-only startup catalog gets a synthetic response", () => {
  const request = { url: "https://hud-layout.test/api/v1/voice/catalog", method: "GET" };
  const response = responseForRequest(request, Buffer.from("html"), fixtureFor("empty"));
  assert.deepEqual(JSON.parse(response.body.toString()), { commands: [] });
  assert.equal(responseForRequest({ ...request, method: "POST" }), null);
  assert.equal(
    responseForRequest({ ...request, url: "https://live.example/api/v1/voice/catalog" }),
    null,
  );
});

test("browser exceptions and console errors fail the gate", () => {
  assert.match(
    browserError({
      method: "Runtime.exceptionThrown",
      params: { exceptionDetails: { exception: { description: "TypeError: render failed" } } },
    }),
    /render failed/,
  );
  assert.match(
    browserError({
      method: "Runtime.consoleAPICalled",
      params: { type: "error", args: [{ value: "render failed" }] },
    }),
    /render failed/,
  );
  assert.equal(
    browserError({
      method: "Runtime.consoleAPICalled",
      params: { type: "log", args: [{ value: "ready" }] },
    }),
    null,
  );
});
