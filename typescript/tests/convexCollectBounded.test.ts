import assert from "node:assert/strict";
import { describe, it } from "node:test";

import { collectBounded, MAX_OWNER_LIST_RESULTS } from "../convex/authHelpers.js";

function fakeQuery(total: number) {
  return {
    async take(count: number) {
      return Array.from({ length: Math.min(count, total) }, (_unused, index) => index);
    },
  };
}

describe("collectBounded", () => {
  it("returns every row when the count is at or below the cap", async () => {
    const exact = await collectBounded(fakeQuery(MAX_OWNER_LIST_RESULTS), "Task");
    assert.equal(exact.length, MAX_OWNER_LIST_RESULTS);

    const few = await collectBounded(fakeQuery(3), "Task");
    assert.deepEqual(few, [0, 1, 2]);
  });

  it("takes one past the cap so an overflow is detectable", async () => {
    let requested = -1;
    await collectBounded(
      {
        async take(count: number) {
          requested = count;
          return [];
        },
      },
      "Task",
    );
    assert.equal(requested, MAX_OWNER_LIST_RESULTS + 1);
  });

  it("fails closed instead of silently truncating when the cap is exceeded", async () => {
    await assert.rejects(
      () => collectBounded(fakeQuery(MAX_OWNER_LIST_RESULTS + 1), "Reminder"),
      /Reminder list exceeds the bounded read limit of 1000 records\./,
    );
  });
});
