import { convexTest } from "convex-test";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { api } from "./_generated/api.js";
import schema from "./schema.js";
import { modules } from "./test.setup.js";

const SERVICE_TOKEN = "reminder-reschedule-service-token-000000";

function context(key: string) {
  return {
    idempotencyKey: key,
    actionFingerprint: `fingerprint:${key}`,
    sourceRequestId: `request:${key}`,
    correlationId: `correlation:${key}`,
    source: "test",
  };
}

async function seed(projectId = "voice-1") {
  const t = convexTest(schema, modules);
  const created = await t.mutation(api.reminders.createControlled, {
    serviceToken: SERVICE_TOKEN,
    projectId,
    title: "Order bar oil",
    dueRaw: "tomorrow at 7 am",
    dueAt: 1_800_000_000_000,
    dueTimezone: "Australia/Sydney",
    ...context("create-1"),
  });
  return { t, created };
}

beforeEach(() => {
  vi.stubEnv("JARVIS_SERVICE_TOKEN", SERVICE_TOKEN);
});

afterEach(() => {
  vi.unstubAllEnvs();
});

describe("AM-017 rescheduleControlled", () => {
  it("replaces the due value, bumps the revision and replays the retained result", async () => {
    const { t, created } = await seed();
    const input = {
      serviceToken: SERVICE_TOKEN,
      projectId: "voice-1",
      id: created.id,
      dueRaw: "friday at 9 am",
      dueAt: 1_800_500_000_000,
      dueTimezone: "Australia/Sydney",
      ...context("reschedule-1"),
    };
    const first = await t.mutation(api.reminders.rescheduleControlled, input);
    expect(first).toMatchObject({
      kind: "reminder",
      id: created.id,
      title: "Order bar oil",
      dueRaw: "friday at 9 am",
      dueAt: 1_800_500_000_000,
      dueTimezone: "Australia/Sydney",
      revision: created.revision + 1,
    });

    // A replay of the same execution returns the original result and changes nothing.
    const replay = await t.mutation(api.reminders.rescheduleControlled, input);
    expect(replay).toEqual(first);
    const stored = await t.query(api.reminders.getControlled, {
      serviceToken: SERVICE_TOKEN,
      projectId: "voice-1",
      id: created.id,
    });
    expect(stored?.revision).toBe(created.revision + 1);

    const receipts = await t.run(async (ctx) =>
      (await ctx.db.query("internalActionResults").collect()).filter(
        (row) => row.actionFamilyId === "AM-017",
      ),
    );
    expect(receipts).toHaveLength(1);
  });

  it("clears a stored time when the new due value has none", async () => {
    const { t, created } = await seed();
    const result = await t.mutation(api.reminders.rescheduleControlled, {
      serviceToken: SERVICE_TOKEN,
      projectId: "voice-1",
      id: created.id,
      dueRaw: "friday",
      ...context("reschedule-undated"),
    });
    expect(result?.dueRaw).toBe("friday");
    expect(result?.dueAt).toBeUndefined();
    expect(result?.dueTimezone).toBeUndefined();
  });

  it("rejects a fingerprint collision and an unpaired timestamp", async () => {
    const { t, created } = await seed();
    const base = {
      serviceToken: SERVICE_TOKEN,
      projectId: "voice-1",
      id: created.id,
      dueRaw: "friday at 9 am",
      dueAt: 1_800_500_000_000,
      dueTimezone: "Australia/Sydney",
      ...context("reschedule-2"),
    };
    await t.mutation(api.reminders.rescheduleControlled, base);
    await expect(
      t.mutation(api.reminders.rescheduleControlled, {
        ...base,
        dueRaw: "saturday",
        actionFingerprint: "fingerprint:other",
      }),
    ).rejects.toThrow(/another fingerprint/);
    await expect(
      t.mutation(api.reminders.rescheduleControlled, {
        serviceToken: SERVICE_TOKEN,
        projectId: "voice-1",
        id: created.id,
        dueRaw: "friday at 9 am",
        dueAt: 1_800_500_000_000,
        ...context("reschedule-unpaired"),
      }),
    ).rejects.toThrow(/timestamp and timezone/);
  });

  it("returns null for another project or a missing reminder, without a receipt", async () => {
    const { t, created } = await seed();
    expect(
      await t.mutation(api.reminders.rescheduleControlled, {
        serviceToken: SERVICE_TOKEN,
        projectId: "other-project",
        id: created.id,
        dueRaw: "friday",
        ...context("reschedule-other"),
      }),
    ).toBeNull();
    const receipts = await t.run(async (ctx) =>
      (await ctx.db.query("internalActionResults").collect()).filter(
        (row) => row.actionFamilyId === "AM-017",
      ),
    );
    expect(receipts).toHaveLength(0);
    const stored = await t.query(api.reminders.getControlled, {
      serviceToken: SERVICE_TOKEN,
      projectId: "voice-1",
      id: created.id,
    });
    expect(stored?.dueRaw).toBe("tomorrow at 7 am");
  });
});
