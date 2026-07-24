import assert from "node:assert/strict";
import { describe, it } from "node:test";

import type {
  CancelControlledReminderInput,
  ControlledReminderRecord,
  ControlledReminderStore,
  CreateControlledReminderInput,
} from "../src/reminders/controlledReminder.js";

class DurableReminderStore implements ControlledReminderStore {
  private sequence = 0;
  private readonly reminders = new Map<string, ControlledReminderRecord>();
  private readonly creates = new Map<
    string,
    { fingerprint: string; result: ControlledReminderRecord }
  >();
  private readonly cancellations = new Map<
    string,
    { fingerprint: string; result: ControlledReminderRecord }
  >();

  async create(input: CreateControlledReminderInput): Promise<ControlledReminderRecord> {
    const key = `${input.projectId}:${input.idempotencyKey}`;
    const existing = this.creates.get(key);
    if (existing) {
      if (existing.fingerprint !== input.actionFingerprint) {
        throw new Error("Reminder create idempotency key belongs to another action fingerprint.");
      }
      return { ...existing.result };
    }

    const now = 200 + this.sequence;
    const reminder: ControlledReminderRecord = {
      id: `reminder-${++this.sequence}`,
      projectId: input.projectId,
      title: input.title,
      ...(input.dueRaw === undefined ? {} : { dueRaw: input.dueRaw }),
      ...(input.dueAt === undefined ? {} : { dueAt: input.dueAt }),
      ...(input.dueTimezone === undefined ? {} : { dueTimezone: input.dueTimezone }),
      createdAt: now,
      updatedAt: now,
      revision: 1,
    };
    this.reminders.set(reminder.id, reminder);
    this.creates.set(key, { fingerprint: input.actionFingerprint, result: reminder });
    return { ...reminder };
  }

  async cancel(input: CancelControlledReminderInput): Promise<ControlledReminderRecord | null> {
    const key = `${input.projectId}:${input.idempotencyKey}`;
    const existingResult = this.cancellations.get(key);
    if (existingResult) {
      if (existingResult.fingerprint !== input.actionFingerprint) {
        throw new Error("Reminder cancellation idempotency key belongs to another fingerprint.");
      }
      return { ...existingResult.result };
    }

    const reminder = this.reminders.get(input.reminderId);
    if (!reminder || reminder.projectId !== input.projectId) return null;
    const cancelled: ControlledReminderRecord = {
      ...reminder,
      updatedAt: reminder.updatedAt + 1,
      revision: reminder.revision + 1,
      cancelledAt: reminder.updatedAt + 1,
    };
    this.cancellations.set(key, {
      fingerprint: input.actionFingerprint,
      result: cancelled,
    });
    this.reminders.delete(reminder.id);
    return { ...cancelled };
  }

  async get(projectId: string, reminderId: string): Promise<ControlledReminderRecord | null> {
    const reminder = this.reminders.get(reminderId);
    return reminder?.projectId === projectId ? { ...reminder } : null;
  }

  async cleanup(projectId: string, reminderId: string): Promise<boolean> {
    const reminder = this.reminders.get(reminderId);
    let changed = false;
    if (reminder?.projectId === projectId) {
      this.reminders.delete(reminderId);
      changed = true;
    }
    for (const [key, value] of this.creates) {
      if (value.result.projectId === projectId && value.result.id === reminderId) {
        this.creates.delete(key);
        changed = true;
      }
    }
    for (const [key, value] of this.cancellations) {
      if (value.result.projectId === projectId && value.result.id === reminderId) {
        this.cancellations.delete(key);
        changed = true;
      }
    }
    return changed;
  }
}

function createInput(
  overrides: Partial<CreateControlledReminderInput> = {},
): CreateControlledReminderInput {
  return {
    projectId: "project-1",
    title: "Check compressor pressure",
    dueRaw: "tomorrow 7:00 am",
    dueAt: 1_785_000_000_000,
    dueTimezone: "Australia/Melbourne",
    idempotencyKey: "reminder-create-key",
    actionFingerprint: "jarvis-action-fingerprint:v1:create-reminder",
    sourceRequestId: "request-reminder-create",
    correlationId: "correlation-reminder-create",
    source: "test",
    ...overrides,
  };
}

describe("controlled reminder actions", () => {
  it("returns the exact create result for an idempotent replay", async () => {
    const store = new DurableReminderStore();
    const first = await store.create(createInput());
    const replay = await store.create(createInput());

    assert.deepEqual(replay, first);
    assert.equal(replay.id, "reminder-1");
  });

  it("rejects a create-key collision with a different fingerprint", async () => {
    const store = new DurableReminderStore();
    await store.create(createInput());
    await assert.rejects(
      store.create(
        createInput({
          title: "Different reminder",
          actionFingerprint: "jarvis-action-fingerprint:v1:different-reminder",
        }),
      ),
      /another action fingerprint/,
    );
    assert.equal((await store.get("project-1", "reminder-1"))?.title, "Check compressor pressure");
  });

  it("retains the cancellation result after deleting the live reminder", async () => {
    const store = new DurableReminderStore();
    const reminder = await store.create(createInput());
    const cancellation: CancelControlledReminderInput = {
      projectId: "project-1",
      reminderId: reminder.id,
      idempotencyKey: "reminder-cancel-key",
      actionFingerprint: "jarvis-action-fingerprint:v1:cancel-reminder",
      sourceRequestId: "request-reminder-cancel",
      correlationId: "correlation-reminder-cancel",
      source: "test",
    };

    const first = await store.cancel(cancellation);
    assert.equal(first?.cancelledAt, first?.updatedAt);
    assert.equal(first?.revision, 2);
    assert.equal(await store.get("project-1", reminder.id), null);

    const replay = await store.cancel(cancellation);
    assert.deepEqual(replay, first);
  });

  it("rejects cancellation-key collisions and hides cross-project records", async () => {
    const store = new DurableReminderStore();
    const reminder = await store.create(createInput());
    const cancellation: CancelControlledReminderInput = {
      projectId: "project-1",
      reminderId: reminder.id,
      idempotencyKey: "reminder-cancel-key",
      actionFingerprint: "jarvis-action-fingerprint:v1:cancel-reminder",
      sourceRequestId: "request-reminder-cancel",
      correlationId: "correlation-reminder-cancel",
      source: "test",
    };
    await store.cancel(cancellation);

    await assert.rejects(
      store.cancel({
        ...cancellation,
        actionFingerprint: "jarvis-action-fingerprint:v1:different-cancel",
      }),
      /another fingerprint/,
    );
    assert.equal(await store.get("project-2", reminder.id), null);
  });

  it("returns null for stale cancellation without creating a tombstone", async () => {
    const store = new DurableReminderStore();
    const result = await store.cancel({
      projectId: "project-1",
      reminderId: "missing-reminder",
      idempotencyKey: "missing-cancel-key",
      actionFingerprint: "jarvis-action-fingerprint:v1:missing-cancel",
      sourceRequestId: "request-missing-cancel",
      correlationId: "correlation-missing-cancel",
      source: "test",
    });
    assert.equal(result, null);
  });
});
