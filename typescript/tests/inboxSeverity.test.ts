import assert from "node:assert/strict";
import { describe, it } from "node:test";

import {
  compareInboxItems,
  SEVERITY_RANK,
  type InboxOrderable,
} from "../src/operations/inboxSeverity.js";

function item(overrides: Partial<InboxOrderable> = {}): InboxOrderable {
  return {
    itemId: "item-1",
    severity: "normal",
    sourceSubsystem: "reminders",
    dueAt: undefined,
    ...overrides,
  };
}

describe("inbox severity ranking", () => {
  it("ranks critical above high above elevated above normal above informational", () => {
    assert.ok(SEVERITY_RANK.critical < SEVERITY_RANK.high);
    assert.ok(SEVERITY_RANK.high < SEVERITY_RANK.elevated);
    assert.ok(SEVERITY_RANK.elevated < SEVERITY_RANK.normal);
    assert.ok(SEVERITY_RANK.normal < SEVERITY_RANK.informational);
  });

  it("sorts strictly by severity first, regardless of due date", () => {
    const critical = item({ itemId: "c", severity: "critical", dueAt: "2026-08-01T00:00:00.000Z" });
    const normal = item({ itemId: "n", severity: "normal", dueAt: "2026-07-31T00:00:00.000Z" });
    const sorted = [normal, critical].sort(compareInboxItems);
    assert.deepEqual(
      sorted.map((entry) => entry.itemId),
      ["c", "n"],
    );
  });

  it("within equal severity, sorts earlier due dates first", () => {
    const later = item({
      itemId: "later",
      severity: "elevated",
      dueAt: "2026-08-05T00:00:00.000Z",
    });
    const sooner = item({
      itemId: "sooner",
      severity: "elevated",
      dueAt: "2026-08-01T00:00:00.000Z",
    });
    const sorted = [later, sooner].sort(compareInboxItems);
    assert.deepEqual(
      sorted.map((entry) => entry.itemId),
      ["sooner", "later"],
    );
  });

  it("items without a due date sort after items with one, at equal severity", () => {
    const undated = item({ itemId: "undated", severity: "normal", dueAt: undefined });
    const dated = item({ itemId: "dated", severity: "normal", dueAt: "2026-08-01T00:00:00.000Z" });
    const sorted = [undated, dated].sort(compareInboxItems);
    assert.deepEqual(
      sorted.map((entry) => entry.itemId),
      ["dated", "undated"],
    );
  });

  it("breaks a tie on equal severity and equal due date by sourceSubsystem, then itemId", () => {
    const sameInstant = "2026-08-01T00:00:00.000Z";
    const a = item({
      itemId: "z-item",
      severity: "normal",
      sourceSubsystem: "reminders",
      dueAt: sameInstant,
    });
    const b = item({
      itemId: "a-item",
      severity: "normal",
      sourceSubsystem: "maintenance",
      dueAt: sameInstant,
    });
    const c = item({
      itemId: "a-item",
      severity: "normal",
      sourceSubsystem: "reminders",
      dueAt: sameInstant,
    });
    const sorted = [a, b, c].sort(compareInboxItems);
    assert.deepEqual(
      sorted.map((entry) => `${entry.sourceSubsystem}:${entry.itemId}`),
      ["maintenance:a-item", "reminders:a-item", "reminders:z-item"],
    );
  });

  it("is a stable total order regardless of input order (no non-determinism)", () => {
    const items = [
      item({ itemId: "1", severity: "informational" }),
      item({ itemId: "2", severity: "critical" }),
      item({ itemId: "3", severity: "high" }),
      item({ itemId: "4", severity: "critical" }),
    ];
    const first = [...items].sort(compareInboxItems).map((entry) => entry.itemId);
    const shuffled = [items[3], items[0], items[2], items[1]];
    const second = shuffled.sort(compareInboxItems).map((entry) => entry.itemId);
    assert.deepEqual(first, second);
  });
});
