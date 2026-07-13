import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, it } from "node:test";

import { getFunctionName } from "convex/server";

import {
  ConvexPersistence,
  JSONPersistence,
  reminderFunctions,
  taskFunctions,
  type ConvexClientLike,
} from "../src/persistence/persistence.js";

type ConvexStub = {
  query(reference: unknown, args?: Record<string, unknown>): Promise<unknown>;
  mutation(reference: unknown, args: Record<string, unknown>): Promise<unknown>;
};

function asConvexClient(stub: ConvexStub): ConvexClientLike {
  return stub as ConvexClientLike;
}

function functionName(reference: unknown): string {
  return getFunctionName(reference as Parameters<typeof getFunctionName>[0]);
}

let tempDir = "";

beforeEach(async () => {
  tempDir = await fs.mkdtemp(path.join(os.tmpdir(), "jarvis-update-test-"));
});

afterEach(async () => {
  await fs.rm(tempDir, { recursive: true, force: true });
});

describe("JSON update contracts", () => {
  it("updates task title and category without changing identity, completion, or creation time", async () => {
    const file = path.join(tempDir, "state.json");
    const provider = new JSONPersistence(file);
    const created = await provider.addTask("Old title", "personal");
    await provider.completeTask(created.id);

    const updated = await provider.updateTask(created.id, {
      title: "  Revised title  ",
      category: "  work  ",
    });

    assert.deepEqual(updated, {
      ...created,
      title: "Revised title",
      category: "work",
      completed: true,
    });
    assert.deepEqual((await new JSONPersistence(file).listTasks())[0], updated);
  });

  it("updates and explicitly clears reminder due data while preserving identity", async () => {
    const file = path.join(tempDir, "state.json");
    const provider = new JSONPersistence(file);
    const created = await provider.addReminder("Old reminder", { raw: "Monday" });
    const at = Date.parse("2026-07-16T23:00:00.000Z");

    const updated = await provider.updateReminder(created.id, {
      title: "Revised reminder",
      due: { raw: "Friday 9am", at, timezone: "Australia/Melbourne" },
    });
    assert.deepEqual(updated, {
      id: created.id,
      title: "Revised reminder",
      dueRaw: "Friday 9am",
      dueAt: at,
      dueTimezone: "Australia/Melbourne",
      createdAt: created.createdAt,
    });

    const cleared = await provider.updateReminder(created.id, { due: null });
    assert.deepEqual(cleared, {
      id: created.id,
      title: "Revised reminder",
      createdAt: created.createdAt,
    });
    assert.deepEqual((await new JSONPersistence(file).listReminders())[0], cleared);
  });

  it("rejects no-op or empty updates and returns null for missing IDs", async () => {
    const provider = new JSONPersistence(path.join(tempDir, "state.json"));
    await assert.rejects(
      () => provider.updateTask("missing", {}),
      /requires --title or --category/,
    );
    await assert.rejects(
      () => provider.updateTask("missing", { title: "   " }),
      /Task title cannot be empty/,
    );
    await assert.rejects(
      () => provider.updateReminder("missing", {}),
      /requires --title, --due, or --clear-due/,
    );
    assert.equal(await provider.updateTask("missing", { title: "Valid" }), null);
    assert.equal(await provider.updateReminder("missing", { title: "Valid" }), null);
  });
});

describe("Convex update adapter", () => {
  it("uses generated task and reminder update functions with matching arguments", async () => {
    const at = Date.parse("2026-07-16T23:00:00.000Z");
    const calls: Array<{ name: string; args: Record<string, unknown> }> = [];
    const client = asConvexClient({
      async query() {
        return [];
      },
      async mutation(reference, args) {
        const name = functionName(reference);
        calls.push({ name, args });
        if (name === functionName(taskFunctions.update)) {
          return {
            _id: "task-id",
            _creationTime: 1,
            ownerId: "jarvis-cli",
            title: "Revised task",
            completed: false,
            category: "work",
            createdAt: 1,
          };
        }
        return {
          _id: "reminder-id",
          _creationTime: 2,
          ownerId: "jarvis-cli",
          title: "Revised reminder",
          ...(args.clearDue === true
            ? {}
            : {
                dueRaw: "Friday 9am",
                dueAt: at,
                dueTimezone: "Australia/Melbourne",
              }),
          createdAt: 2,
        };
      },
    });
    const provider = new ConvexPersistence(client, "test-token");

    const task = await provider.updateTask("task-id", {
      title: " Revised task ",
      category: " work ",
    });
    assert.equal(task?.title, "Revised task");

    const reminder = await provider.updateReminder("reminder-id", {
      title: " Revised reminder ",
      due: { raw: "Friday 9am", at, timezone: "Australia/Melbourne" },
    });
    assert.equal(reminder?.dueAt, at);

    const cleared = await provider.updateReminder("reminder-id", { due: null });
    assert.equal(cleared?.dueRaw, undefined);

    assert.deepEqual(calls, [
      {
        name: functionName(taskFunctions.update),
        args: {
          serviceToken: "test-token",
          id: "task-id",
          title: "Revised task",
          category: "work",
        },
      },
      {
        name: functionName(reminderFunctions.update),
        args: {
          serviceToken: "test-token",
          id: "reminder-id",
          title: "Revised reminder",
          dueRaw: "Friday 9am",
          dueAt: at,
          dueTimezone: "Australia/Melbourne",
        },
      },
      {
        name: functionName(reminderFunctions.update),
        args: {
          serviceToken: "test-token",
          id: "reminder-id",
          clearDue: true,
        },
      },
    ]);
  });

  it("normalises malformed Convex IDs to null for both update methods", async () => {
    const provider = new ConvexPersistence(
      asConvexClient({
        async query() {
          return [];
        },
        async mutation() {
          throw new Error("ArgumentValidationError: invalid Convex ID");
        },
      }),
      "test-token",
    );

    assert.equal(await provider.updateTask("garbage", { title: "Valid" }), null);
    assert.equal(await provider.updateReminder("garbage", { title: "Valid" }), null);
  });
});
