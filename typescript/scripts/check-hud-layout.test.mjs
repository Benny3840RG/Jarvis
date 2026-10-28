import assert from "node:assert/strict";
import test from "node:test";
import { readFileSync } from "node:fs";
import { runInNewContext } from "node:vm";
import {
  assessPanels,
  assessVisibility,
  assessNoOverlap,
  fixtureFor,
  parseArgs,
  measureElement,
  responseForRequest,
  browserError,
  scrollTacticalNode,
  scrollRightReadout,
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
    closest: () => null,
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

test("narrow tactical checks scroll the page only, preserving the complete plate", () => {
  const calls = [];
  runInNewContext(`(${scrollTacticalNode.toString()})(".node", 1366)`, {
    innerHeight: 768,
    document: {
      querySelector: (selector) =>
        selector === ".node"
          ? { scrollIntoView: () => calls.push("hidden ancestor scroll") }
          : { getBoundingClientRect: () => ({ top: 350, height: 222 }) },
    },
    window: {
      scrollBy: (options) =>
        calls.push({ top: options.top, left: options.left, behavior: options.behavior }),
    },
  });
  assert.deepEqual(calls, [{ top: 77, left: 0, behavior: "instant" }]);
});

test("desktop tactical checks still scroll individual labels within their list", () => {
  const calls = [];
  runInNewContext(`(${scrollTacticalNode.toString()})(".node", 1920)`, {
    document: { querySelector: () => ({ scrollIntoView: (options) => calls.push(options.block) }) },
    window: { scrollBy: () => calls.push("unexpected page scroll") },
  });
  assert.deepEqual(calls, ["nearest"]);
});

function rightScrollHarness(overflowY, width) {
  const pageScrolls = [];
  const column = {
    clientTop: 1,
    clientHeight: 100,
    scrollHeight: 400,
    scrollTop: 0,
    contains: () => true,
    getBoundingClientRect: () => ({ top: 100 }),
  };
  const target = {
    getBoundingClientRect: () => ({
      top: 230 - column.scrollTop,
      bottom: 250 - column.scrollTop,
      height: 20,
    }),
    scrollIntoView: () => {
      throw new Error("Hidden ancestor scrolling is forbidden");
    },
  };
  const result = runInNewContext(`(${scrollRightReadout.toString()})("#value", ${width})`, {
    innerHeight: 768,
    document: { querySelector: (selector) => (selector === ".col-right" ? column : target) },
    getComputedStyle: () => ({ overflowY }),
    window: { scrollBy: (options) => pageScrolls.push(options.top) },
  });
  return { column, result, pageScrolls };
}

test("right readouts use only their explicitly scrollable column", () => {
  const { column, result, pageScrolls } = rightScrollHarness("auto", 1920);
  assert.equal(column.scrollTop, 49);
  assert.equal(result.scrollHeight, 400);
  assert.equal(result.scrollTop, 49);
  assert.deepEqual(pageScrolls, []);
});

test("right readouts never programmatically scroll hidden overflow", () => {
  const { column, pageScrolls } = rightScrollHarness("hidden", 1920);
  assert.equal(column.scrollTop, 0);
  assert.deepEqual(pageScrolls, []);
});

test("narrow right readouts combine explicit column scrolling with page-only positioning", () => {
  const { column, pageScrolls } = rightScrollHarness("auto", 1366);
  assert.equal(column.scrollTop, 49);
  assert.deepEqual(pageScrolls, [-193]);
});

function bezelMeasurement({
  shellZ = 2,
  bezelDisplay = "block",
  filled = true,
  fillOpacity = "1",
} = {}) {
  const shell = {};
  const bezel = {};
  const sampled = [];
  const path = {
    closest: () => bezel,
    getScreenCTM: () => ({ inverse: () => ({ scale: 0.5 }) }),
    isPointInFill: (point) => {
      sampled.push(point);
      return filled;
    },
  };
  const element = {
    id: "readout",
    tagName: "SPAN",
    classList: [],
    textContent: "test",
    parentElement: null,
    closest: () => shell,
    getBoundingClientRect: () => ({ ...rect(10, 10, 70, 24), width: 60, height: 14 }),
  };
  const style = {
    display: "block",
    visibility: "visible",
    opacity: "1",
    clip: "auto",
    overflowX: "visible",
    overflowY: "visible",
    zIndex: "auto",
    fill: "url(#steel)",
    fillOpacity: "1",
  };
  class Point {
    constructor(x, y) {
      this.x = x;
      this.y = y;
    }
    matrixTransform(matrix) {
      return { x: this.x * matrix.scale, y: this.y * matrix.scale };
    }
  }
  const result = runInNewContext(
    `(${measureElement.toString()})("#readout",{text:false,hitTest:false})`,
    {
      innerWidth: 1920,
      innerHeight: 1080,
      DOMPoint: Point,
      document: { querySelector: () => element, querySelectorAll: () => [path] },
      getComputedStyle: (target) =>
        target === shell
          ? { ...style, zIndex: String(shellZ) }
          : target === bezel
            ? { ...style, zIndex: "8", display: bezelDisplay }
            : target === path
              ? { ...style, fillOpacity }
              : style,
    },
  );
  return { result, sampled };
}

test("opaque pointer-events-none bezel geometry still rejects covered content", () => {
  const { result, sampled } = bezelMeasurement();
  assert.ok(assessVisibility(result).some((failure) => failure.includes("bezel")));
  assert.ok(
    sampled.some((point) => point.x < 10 && point.y < 10),
    "screen points must use the inverse SVG transform",
  );
});

test("bezel openings and hidden or transparent masks do not cover content", () => {
  assert.equal(assessVisibility(bezelMeasurement({ filled: false }).result).length, 0);
  assert.equal(assessVisibility(bezelMeasurement({ bezelDisplay: "none" }).result).length, 0);
  assert.equal(assessVisibility(bezelMeasurement({ fillOpacity: "0" }).result).length, 0);
});

test("wide Focus content above the bezel is not reported as covered", () => {
  const { result, sampled } = bezelMeasurement({ shellZ: 10 });
  assert.equal(assessVisibility(result).length, 0);
  assert.equal(sampled.length, 0);
});

test("assessPanels fails cut-off, clipped, and squeezed panels", () => {
  const workspace = rect(0, 100, 1800, 1000);
  const panel = (
    title,
    box,
    heading = rect(box.left + 8, box.top + 8, box.left + 120, box.top + 24),
  ) => ({ title, box, heading });
  assert.deepEqual(
    assessPanels("systems", { workspace, panels: [panel("Runtime", rect(10, 110, 600, 990))] }),
    [],
  );
  assert.match(
    assessPanels("systems", {
      workspace,
      panels: [panel("Approvals", rect(10, 900, 600, 1100))],
    })[0],
    /Approvals" runs outside/,
  );
  assert.match(
    assessPanels("operations", {
      workspace,
      panels: [panel("Inbox", rect(10, 110, 600, 300), rect(18, 290, 120, 310))],
    })[0],
    /heading "Inbox" is clipped/,
  );
  assert.match(
    assessPanels("operations", {
      workspace,
      panels: [panel("Timeline", rect(10, 110, 600, 112), null)],
    })[0],
    /squeezed to 2px/,
  );
  assert.match(assessPanels("voice", { workspace, panels: [] })[0], /no panels/);
  // Settings scrolls its own view, so a card below the fold is reachable.
  assert.deepEqual(
    assessPanels("settings", {
      workspace,
      panels: [{ ...panel("Display", rect(10, 900, 600, 1300)), scrolls: true }],
    }),
    [],
  );
});
