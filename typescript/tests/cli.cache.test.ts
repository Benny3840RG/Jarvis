import assert from "node:assert/strict";
import { describe, it } from "node:test";

import { upsertById } from "../src/cli.js";

describe("CLI durable-record cache", () => {
  it("replaces an existing record without mutating the original list", () => {
    const original = [
      { id: "task-1", title: "Old" },
      { id: "task-2", title: "Keep" },
    ];
    const updated = { id: "task-1", title: "Updated" };

    assert.deepEqual(upsertById(original, updated), [updated, original[1]]);
    assert.equal(original[0].title, "Old");
  });

  it("appends a durable record that was absent from the running session", () => {
    const existing = [{ id: "task-1", title: "Existing" }];
    const external = { id: "task-2", title: "Created elsewhere" };

    assert.deepEqual(upsertById(existing, external), [...existing, external]);
  });
});
