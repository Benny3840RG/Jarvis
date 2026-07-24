import assert from "node:assert/strict";
import { describe, it } from "node:test";

import { ConvexControlledReminderStore } from "../src/persistence/convexControlledReminders.js";
import type { ConvexClientLike } from "../src/persistence/convexPersistence.js";

function reminderRow(overrides: Partial<Record<string, unknown>> = {}) {
  return {
    kind: "reminder",
    id: "reminder-1",
    projectId: "project-1",
    title: "Check compressor pressure",
    dueRaw: "tomorrow 7:00 am",
    dueAt: 1_785_000_000_000,
    dueTimezone: "Australia/Melbourne",
    createdAt: 1,
    updatedAt: 1,
    revision: 1,
    ...overrides,
  };
}

describe("ConvexControlledReminderStore", () => {
  it("creates a controlled reminder through the authenticated mutation", async () => {
    const calls: unknown[] = [];
    const client = {
      async query() {
        throw new Error("query must not be called");
      },
      async mutation(_ref: unknown, args: unknown) {
        calls.push(args);
        return reminderRow();
      },
    } as unknown as ConvexClientLike;
    const store = new ConvexControlledReminderStore(client, "owner-service-token");

    const result = await store.create({
      projectId: "project-1",
      title: "Check compressor pressure",
      dueRaw: "tomorrow 7:00 am",
      dueAt: 1_785_000_000_000,
      dueTimezone: "Australia/Melbourne",
      idempotencyKey: "reminder-create-key",
      actionFingerprint: "jarvis-action-fingerprint:v1:abc",
      sourceRequestId: "request-reminder-create",
      correlationId: "correlation-reminder-create",
      source: "tool-action-http",
    });

    assert.equal(result.id, "reminder-1");
    assert.equal(result.dueTimezone, "Australia/Melbourne");
    assert.deepEqual(calls[0], {
      serviceToken: "owner-service-token",
      projectId: "project-1",
      title: "Check compressor pressure",
      dueRaw: "tomorrow 7:00 am",
      dueAt: 1_785_000_000_000,
      dueTimezone: "Australia/Melbourne",
      idempotencyKey: "reminder-create-key",
      actionFingerprint: "jarvis-action-fingerprint:v1:abc",
      sourceRequestId: "request-reminder-create",
      correlationId: "correlation-reminder-create",
      source: "tool-action-http",
    });
  });

  it("cancels, retrieves and cleans up only the requested project reminder", async () => {
    const calls: Array<{ kind: string; args: unknown }> = [];
    const client = {
      async query(_ref: unknown, args: unknown) {
        calls.push({ kind: "query", args });
        return reminderRow();
      },
      async mutation(_ref: unknown, args: unknown) {
        calls.push({ kind: "mutation", args });
        const values = args as Record<string, unknown>;
        if ("idempotencyKey" in values) {
          return reminderRow({ updatedAt: 2, revision: 2, cancelledAt: 2 });
        }
        return true;
      },
    } as unknown as ConvexClientLike;
    const store = new ConvexControlledReminderStore(client, "owner-service-token");

    const cancelled = await store.cancel({
      projectId: "project-1",
      reminderId: "reminder-1",
      idempotencyKey: "reminder-cancel-key",
      actionFingerprint: "jarvis-action-fingerprint:v1:def",
      sourceRequestId: "request-reminder-cancel",
      correlationId: "correlation-reminder-cancel",
      source: "tool-action-http",
    });
    const fetched = await store.get("project-1", "reminder-1");
    const cleaned = await store.cleanup("project-1", "reminder-1");

    assert.equal(cancelled?.cancelledAt, 2);
    assert.equal(fetched?.id, "reminder-1");
    assert.equal(cleaned, true);
    assert.deepEqual(
      calls.map(({ args }) => args),
      [
        {
          serviceToken: "owner-service-token",
          projectId: "project-1",
          id: "reminder-1",
          idempotencyKey: "reminder-cancel-key",
          actionFingerprint: "jarvis-action-fingerprint:v1:def",
          sourceRequestId: "request-reminder-cancel",
          correlationId: "correlation-reminder-cancel",
          source: "tool-action-http",
        },
        { serviceToken: "owner-service-token", projectId: "project-1", id: "reminder-1" },
        { serviceToken: "owner-service-token", projectId: "project-1", id: "reminder-1" },
      ],
    );
  });

  it("omits absent due fields and preserves null results", async () => {
    const calls: unknown[] = [];
    const client = {
      async query() {
        return null;
      },
      async mutation(_ref: unknown, args: unknown) {
        calls.push(args);
        const values = args as Record<string, unknown>;
        return "title" in values
          ? reminderRow({ dueRaw: undefined, dueAt: undefined, dueTimezone: undefined })
          : null;
      },
    } as unknown as ConvexClientLike;
    const store = new ConvexControlledReminderStore(client, "owner-service-token");

    await store.create({
      projectId: "project-1",
      title: "No due date",
      idempotencyKey: "reminder-no-due-key",
      actionFingerprint: "jarvis-action-fingerprint:v1:no-due",
      sourceRequestId: "request-no-due",
      correlationId: "correlation-no-due",
      source: "test",
    });
    const createArgs = calls[0] as Record<string, unknown>;
    assert.equal("dueRaw" in createArgs, false);
    assert.equal("dueAt" in createArgs, false);
    assert.equal("dueTimezone" in createArgs, false);
    assert.equal(
      await store.cancel({
        projectId: "project-1",
        reminderId: "missing",
        idempotencyKey: "missing-key",
        actionFingerprint: "jarvis-action-fingerprint:v1:missing",
        sourceRequestId: "request-missing",
        correlationId: "correlation-missing",
        source: "test",
      }),
      null,
    );
    assert.equal(await store.get("project-1", "missing"), null);
  });

  it("requires an authenticated service token", () => {
    const client = {
      async query() {
        return null;
      },
      async mutation() {
        return null;
      },
    } as unknown as ConvexClientLike;
    assert.throws(
      () => new ConvexControlledReminderStore(client, ""),
      /require JARVIS_SERVICE_TOKEN/,
    );
  });
});
