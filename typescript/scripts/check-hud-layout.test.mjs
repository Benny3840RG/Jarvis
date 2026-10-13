import assert from "node:assert/strict";
import test from "node:test";
import { assessVisibility, assessNoOverlap, fixtureFor, parseArgs } from "./check-hud-layout.mjs";

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
