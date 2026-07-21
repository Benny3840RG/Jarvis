import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { describe, it } from "node:test";

const widget = readFileSync(new URL("../src/mcp/dashboard-v1.html", import.meta.url), "utf8");

describe("Jarvis preview widget", () => {
  it("uses the MCP Apps bridge and the established black-orange operator style", () => {
    assert.match(widget, /ui\/initialize/);
    assert.match(widget, /ui\/notifications\/tool-result/);
    assert.match(widget, /tools\/call/);
    assert.match(widget, /#ff7a18/i);
    assert.match(widget, /JARVIS \/\/ OPERATOR CONSOLE/);
  });

  it("carries the Beez Treez brand in orange, black, and green", () => {
    // Green is a genuine second accent (brand colour + gradient), not just a
    // status dot, and the console is badged for Beez Treez Property Solutions.
    assert.match(widget, /#3fbf6a/i);
    assert.match(widget, /--brand-gradient/);
    assert.match(widget, /Beez Treez/);
  });

  it("does not contain Jarvis or OpenAI credential names", () => {
    assert.doesNotMatch(widget, /JARVIS_SERVICE_TOKEN/);
    assert.doesNotMatch(widget, /OPENAI_API_KEY/);
    assert.doesNotMatch(widget, /CONVEX_DEPLOY_KEY/);
  });
});
