import assert from "node:assert/strict";
import { describe, it } from "node:test";

import { parseCreateProject, parseUpdateProject } from "../src/http/projectRequest.js";

describe("project request scheduledFor", () => {
  it("accepts a valid ISO date on create and update", () => {
    const created = parseCreateProject({
      clientId: "c1",
      title: "Crown reduction",
      scheduledFor: "2026-10-09",
    });
    assert.equal(created.scheduledFor, "2026-10-09");

    const updated = parseUpdateProject({ scheduledFor: "2026-10-10" });
    assert.equal(updated.scheduledFor, "2026-10-10");
  });

  it("clears the date with null on update", () => {
    const updated = parseUpdateProject({ scheduledFor: null });
    assert.equal(updated.scheduledFor, null);
  });

  it("rejects a non-ISO shape", () => {
    assert.throws(
      () => parseCreateProject({ clientId: "c1", title: "X", scheduledFor: "next Friday" }),
      /ISO date \(YYYY-MM-DD\)/,
    );
    assert.throws(
      () => parseCreateProject({ clientId: "c1", title: "X", scheduledFor: "2026-9-9" }),
      /ISO date \(YYYY-MM-DD\)/,
    );
  });

  it("rejects an impossible calendar date", () => {
    assert.throws(
      () => parseCreateProject({ clientId: "c1", title: "X", scheduledFor: "2026-13-40" }),
      /not a valid calendar date/,
    );
    assert.throws(
      () => parseUpdateProject({ scheduledFor: "2026-02-30" }),
      /not a valid calendar date/,
    );
  });
});
