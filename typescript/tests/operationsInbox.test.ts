import assert from "node:assert/strict";
import { describe, it } from "node:test";

import { buildOperationsInbox } from "../src/operations/operationsInbox.js";
import type { Asset } from "../src/assets/asset.js";
import type { Reminder } from "../src/persistence/types.js";

const NOW = Date.parse("2026-07-30T12:00:00.000Z");

function reminder(overrides: Partial<Reminder> = {}): Reminder {
  return {
    id: "reminder-1",
    title: "Call the supplier",
    dueAt: NOW - 60_000,
    createdAt: NOW - 3_600_000,
    ...overrides,
  };
}

function asset(overrides: Partial<Asset> = {}): Asset {
  return {
    id: "asset-1",
    name: "Bandsaw",
    kind: "tool",
    serviceIntervalDays: 30,
    lastServicedAt: NOW - 40 * 86_400_000, // overdue by 10 days
    createdAt: NOW - 400 * 86_400_000,
    updatedAt: NOW - 40 * 86_400_000,
    ...overrides,
  };
}

async function neverCalled(): Promise<never> {
  throw new Error("must not be called");
}

describe("buildOperationsInbox", () => {
  it("surfaces an overdue reminder and overdue maintenance as inbox items", async () => {
    const inbox = await buildOperationsInbox({
      now: NOW,
      listReminders: async () => [reminder()],
      listAssets: async () => [asset()],
    });

    const kinds = inbox.items.map((item) => item.kind).sort();
    assert.deepEqual(kinds, ["maintenance-overdue", "reminder-overdue"]);
    for (const source of ["reminders", "maintenance"] as const) {
      const report = inbox.sources.find((entry) => entry.source === source);
      assert.equal(report?.status, "available");
    }
  });

  it("reports maintenance due-soon (not yet overdue) as a lower-severity item", async () => {
    const dueSoonAsset = asset({
      id: "asset-2",
      lastServicedAt: NOW - 25 * 86_400_000,
      serviceIntervalDays: 30, // due in 5 days
    });
    const inbox = await buildOperationsInbox({
      now: NOW,
      listReminders: async () => [],
      listAssets: async () => [dueSoonAsset],
    });

    assert.equal(inbox.items.length, 1);
    assert.equal(inbox.items[0]?.kind, "maintenance-due-soon");
    assert.equal(inbox.items[0]?.severity, "normal");
  });

  it("one source's failure is reported as unavailable without failing the whole inbox", async () => {
    const inbox = await buildOperationsInbox({
      now: NOW,
      listReminders: neverCalled,
      listAssets: async () => [asset()],
    });

    const remindersReport = inbox.sources.find((entry) => entry.source === "reminders");
    assert.equal(remindersReport?.status, "unavailable");
    assert.equal(remindersReport?.reason, "Reminders source is temporarily unavailable.");
    assert.doesNotMatch(remindersReport?.reason ?? "", /must not be called/);
    // Maintenance must still succeed even though reminders failed.
    const maintenanceReport = inbox.sources.find((entry) => entry.source === "maintenance");
    assert.equal(maintenanceReport?.status, "available");
    assert.deepEqual(
      inbox.items.map((item) => item.kind),
      ["maintenance-overdue"],
    );
  });

  it("never reports an unavailable source as zero items", async () => {
    const inbox = await buildOperationsInbox({
      now: NOW,
      listReminders: neverCalled,
      listAssets: neverCalled,
    });

    assert.deepEqual(inbox.items, []);
    for (const report of inbox.sources) {
      if (report.source === "reminders" || report.source === "maintenance") {
        assert.equal(report.status, "unavailable");
      }
    }
    // Explicit unavailability, never silently treated as "nothing needs attention".
    assert.equal(
      inbox.sources.every((report) => report.status !== "available"),
      true,
    );
  });

  it("reports the not-yet-wired sources (tool actions, reconciliation, quote delivery) as unsupported, not empty", async () => {
    const inbox = await buildOperationsInbox({
      now: NOW,
      listReminders: async () => [],
      listAssets: async () => [],
    });

    for (const source of ["toolActions", "reconciliation", "quoteDelivery"] as const) {
      const report = inbox.sources.find((entry) => entry.source === source);
      assert.equal(report?.status, "unsupported");
      assert.ok(report?.reason);
    }
  });

  it("orders items deterministically by severity, then due date, then a stable tie-break", async () => {
    const overdueReminder = reminder({ id: "reminder-overdue", dueAt: NOW - 120_000 });
    const overdueMaintenance = asset({
      id: "asset-overdue",
      lastServicedAt: NOW - 40 * 86_400_000,
    });
    const dueSoonMaintenance = asset({
      id: "asset-due-soon",
      lastServicedAt: NOW - 25 * 86_400_000,
    });

    const inbox = await buildOperationsInbox({
      now: NOW,
      listReminders: async () => [overdueReminder],
      listAssets: async () => [overdueMaintenance, dueSoonMaintenance],
    });

    // overdue items (elevated) sort before due-soon items (normal); ties within
    // the overdue group break by sourceSubsystem then itemId, deterministically.
    assert.deepEqual(
      inbox.items.map((item) => item.kind),
      ["maintenance-overdue", "reminder-overdue", "maintenance-due-soon"],
    );
  });

  it("never fabricates a numeric due date for an undated maintenance record", async () => {
    const undatedAsset = asset({
      id: "asset-undated",
      serviceIntervalDays: undefined,
      lastServicedAt: undefined,
    });
    const inbox = await buildOperationsInbox({
      now: NOW,
      listReminders: async () => [],
      listAssets: async () => [undatedAsset],
    });

    assert.deepEqual(inbox.items, []);
  });
});
