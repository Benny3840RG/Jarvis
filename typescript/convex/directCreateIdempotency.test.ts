import { convexTest } from "convex-test";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { api } from "./_generated/api.js";
import schema from "./schema.js";
import { modules } from "./test.setup.js";

const SERVICE_TOKEN = "direct-create-idempotency-token-0000000000";

function harness() {
  return convexTest(schema, modules);
}

beforeEach(() => {
  vi.stubEnv("JARVIS_SERVICE_TOKEN", SERVICE_TOKEN);
});

afterEach(() => {
  vi.unstubAllEnvs();
});

describe("durable direct create idempotency", () => {
  it("replays the same task create key and rejects a changed fingerprint", async () => {
    const t = harness();
    const input = {
      serviceToken: SERVICE_TOKEN,
      title: "Inspect compressor",
      category: "workshop",
      idempotencyKey: "http-task-create-1",
      requestFingerprint: "task-fingerprint-1",
    };

    const first = await t.mutation(api.tasks.create, input);
    const replay = await t.mutation(api.tasks.create, input);

    expect(replay._id).toBe(first._id);
    await expect(
      t.mutation(api.tasks.create, {
        ...input,
        title: "Inspect another compressor",
        requestFingerprint: "task-fingerprint-2",
      }),
    ).rejects.toThrow(/idempotency key conflict/i);
  });

  it("does not recreate a deleted task when its create request is retried", async () => {
    const t = harness();
    const input = {
      serviceToken: SERVICE_TOKEN,
      title: "Inspect compressor",
      category: "workshop",
      idempotencyKey: "http-task-create-deleted",
      requestFingerprint: "task-fingerprint-deleted",
    };

    const created = await t.mutation(api.tasks.create, input);
    await t.mutation(api.tasks.remove, { serviceToken: SERVICE_TOKEN, id: created._id });

    await expect(t.mutation(api.tasks.create, input)).rejects.toThrow(/no longer available/i);
    expect(await t.query(api.tasks.list, { serviceToken: SERVICE_TOKEN })).toHaveLength(0);
  });

  it("replays the same reminder create key and rejects a changed fingerprint", async () => {
    const t = harness();
    const input = {
      serviceToken: SERVICE_TOKEN,
      title: "Check compressor pressure",
      dueRaw: "tomorrow 7am",
      dueAt: 1_785_000_000_000,
      dueTimezone: "Australia/Melbourne",
      idempotencyKey: "http-reminder-create-1",
      requestFingerprint: "reminder-fingerprint-1",
    };

    const first = await t.mutation(api.reminders.create, input);
    const replay = await t.mutation(api.reminders.create, input);

    expect(replay._id).toBe(first._id);
    await expect(
      t.mutation(api.reminders.create, {
        ...input,
        title: "Check receiver pressure",
        requestFingerprint: "reminder-fingerprint-2",
      }),
    ).rejects.toThrow(/idempotency key conflict/i);
  });

  it("does not recreate a deleted reminder when its create request is retried", async () => {
    const t = harness();
    const input = {
      serviceToken: SERVICE_TOKEN,
      title: "Check compressor pressure",
      dueRaw: "tomorrow 7am",
      dueAt: 1_785_000_000_000,
      dueTimezone: "Australia/Melbourne",
      idempotencyKey: "http-reminder-create-deleted",
      requestFingerprint: "reminder-fingerprint-deleted",
    };

    const created = await t.mutation(api.reminders.create, input);
    await t.mutation(api.reminders.remove, { serviceToken: SERVICE_TOKEN, id: created._id });

    await expect(t.mutation(api.reminders.create, input)).rejects.toThrow(/no longer available/i);
    expect(await t.query(api.reminders.list, { serviceToken: SERVICE_TOKEN })).toHaveLength(0);
  });

  it("returns direct-create fields from the assistant snapshot", async () => {
    const t = harness();
    const task = await t.mutation(api.tasks.create, {
      serviceToken: SERVICE_TOKEN,
      title: "Inspect compressor",
      category: "workshop",
      idempotencyKey: "http-task-create-1",
      requestFingerprint: "task-fingerprint-1",
    });
    const reminder = await t.mutation(api.reminders.create, {
      serviceToken: SERVICE_TOKEN,
      title: "Check compressor pressure",
      dueRaw: "tomorrow 7am",
      dueAt: 1_785_000_000_000,
      dueTimezone: "Australia/Melbourne",
      idempotencyKey: "http-reminder-create-1",
      requestFingerprint: "reminder-fingerprint-1",
    });
    await t.run(async (ctx) => {
      await ctx.db.insert("tasks", {
        ownerId: "jarvis-cli",
        title: "Controlled",
        completed: false,
        category: "workshop",
        projectId: "project-1",
        updatedAt: 9,
        revision: 3,
        createdAt: 8,
      });
    });

    const snapshot = await t.query(api.assistantState.snapshot, { serviceToken: SERVICE_TOKEN });
    expect(snapshot.tasks.find((row) => row._id === task._id)).toMatchObject({
      directCreateIdempotencyKey: "http-task-create-1",
      directCreateFingerprint: "task-fingerprint-1",
    });
    expect(snapshot.tasks.find((row) => row.title === "Controlled")).toMatchObject({
      projectId: "project-1",
      updatedAt: 9,
      revision: 3,
    });
    expect(snapshot.reminders.find((row) => row._id === reminder._id)).toMatchObject({
      directCreateIdempotencyKey: "http-reminder-create-1",
      directCreateFingerprint: "reminder-fingerprint-1",
      dueRaw: "tomorrow 7am",
      dueAt: 1_785_000_000_000,
      dueTimezone: "Australia/Melbourne",
    });
  });

  it("requires idempotency key and fingerprint together", async () => {
    const t = harness();

    await expect(
      t.mutation(api.tasks.create, {
        serviceToken: SERVICE_TOKEN,
        title: "Incomplete identity",
        category: "workshop",
        idempotencyKey: "orphan-key",
      }),
    ).rejects.toThrow(/together/i);
  });
});
