import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, it } from "node:test";

import {
  ConvexPersistence,
  JSONPersistence,
  assistantStateFunctions,
  createPersistenceFromEnv,
  reminderFunctions,
  taskFunctions,
  type AssistantState,
  type ConvexClientLike,
} from "../src/persistence/persistence.js";

const originalProvider = process.env.PERSISTENCE_PROVIDER;
const originalUrl = process.env.CONVEX_URL;
let tempDir = "";

beforeEach(async () => {
  delete process.env.PERSISTENCE_PROVIDER;
  delete process.env.CONVEX_URL;
  tempDir = await fs.mkdtemp(path.join(os.tmpdir(), "jarvis-persistence-"));
});

afterEach(async () => {
  if (originalProvider === undefined) delete process.env.PERSISTENCE_PROVIDER;
  else process.env.PERSISTENCE_PROVIDER = originalProvider;
  if (originalUrl === undefined) delete process.env.CONVEX_URL;
  else process.env.CONVEX_URL = originalUrl;
  await fs.rm(tempDir, { recursive: true, force: true });
});

function emptyClient(): ConvexClientLike {
  return {
    async query<T>() {
      return null as T;
    },
    async mutation<T>() {
      return undefined as T;
    },
  };
}

describe("JSONPersistence", () => {
  it("returns empty durable data when file is missing", async () => {
    const provider = new JSONPersistence(path.join(tempDir, "missing.json"));
    assert.deepEqual(await provider.loadState(), {});
    assert.deepEqual(await provider.listTasks(), []);
    assert.deepEqual(await provider.listReminders(), []);
  });

  it("migrates the legacy state-only format without losing state", async () => {
    const file = path.join(tempDir, "legacy.json");
    const legacy = { lastIntent: "testing", retained: "yes" };
    await fs.writeFile(file, JSON.stringify(legacy), "utf8");

    const provider = new JSONPersistence(file);
    assert.deepEqual(await provider.loadState(), legacy);
    assert.deepEqual(await provider.listTasks(), []);

    await provider.addTask("Measure access", "work");
    assert.deepEqual(await provider.loadState(), legacy);
  });

  it("keeps tasks and reminders durable across provider restarts", async () => {
    const file = path.join(tempDir, "durable.json");
    const first = new JSONPersistence(file);

    await first.saveState({ lastIntent: "testing" });
    const task = await first.addTask("Replace trailer floor", "workshop");
    const reminder = await first.addReminder("Call Claire", "tomorrow");

    const second = new JSONPersistence(file);
    assert.deepEqual(await second.loadState(), { lastIntent: "testing" });
    assert.deepEqual(await second.listTasks(), [task]);
    assert.deepEqual(await second.listReminders(), [reminder]);

    const completed = await second.completeTask(task.id);
    assert.equal(completed?.completed, true);
    assert.equal(await second.removeReminder(reminder.id), true);

    const third = new JSONPersistence(file);
    assert.equal((await third.listTasks())[0]?.completed, true);
    assert.deepEqual(await third.listReminders(), []);
  });

  it("returns false for missing durable records", async () => {
    const provider = new JSONPersistence(path.join(tempDir, "missing-records.json"));
    assert.equal(await provider.completeTask("missing"), null);
    assert.equal(await provider.removeReminder("missing"), false);
  });

  it("reports malformed JSON", async () => {
    const file = path.join(tempDir, "bad.json");
    await fs.writeFile(file, "{not json", "utf8");
    await assert.rejects(new JSONPersistence(file).loadState(), /Malformed JSON/);
  });
});

describe("createPersistenceFromEnv", () => {
  it("defaults to JSON", () => {
    assert(createPersistenceFromEnv() instanceof JSONPersistence);
  });

  it("selects Convex with an injected client and no real URL", () => {
    process.env.PERSISTENCE_PROVIDER = "convex";
    assert(createPersistenceFromEnv(emptyClient()) instanceof ConvexPersistence);
  });

  it("fails fast when Convex is selected without a URL or client", () => {
    process.env.PERSISTENCE_PROVIDER = "convex";
    assert.throws(() => createPersistenceFromEnv(), /CONVEX_URL/);
  });

  it("rejects unknown provider names", () => {
    process.env.PERSISTENCE_PROVIDER = "sqlite";
    assert.throws(() => createPersistenceFromEnv(), /Invalid PERSISTENCE_PROVIDER/);
  });
});

describe("ConvexPersistence", () => {
  it("loads and saves assistant state using the expected references", async () => {
    const sample: AssistantState = { lastIntent: "hello" };
    let saved: Record<string, unknown> | undefined;
    const mock: ConvexClientLike = {
      async query<T>(reference: unknown, args?: Record<string, unknown>) {
        assert.equal(reference, assistantStateFunctions.get);
        assert.deepEqual(args, {});
        return { state: sample } as T;
      },
      async mutation<T>(reference: unknown, args: Record<string, unknown>) {
        assert.equal(reference, assistantStateFunctions.upsert);
        saved = args;
        return undefined as T;
      },
    };

    const provider = new ConvexPersistence(mock);
    assert.deepEqual(await provider.loadState(), sample);
    await provider.saveState(sample);
    assert.deepEqual(saved, { state: sample });
  });

  it("maps Convex task rows and sends explicit task mutations", async () => {
    const calls: Array<{ reference: unknown; args: Record<string, unknown> }> = [];
    const mock: ConvexClientLike = {
      async query<T>(reference: unknown, args?: Record<string, unknown>) {
        assert.equal(reference, taskFunctions.list);
        assert.deepEqual(args, {});
        return [
          { _id: "task-1", title: "Measure gate", completed: false, category: "work" },
        ] as T;
      },
      async mutation<T>(reference: unknown, args: Record<string, unknown>) {
        calls.push({ reference, args });
        if (reference === taskFunctions.create) {
          return {
            _id: "task-2",
            title: String(args.title),
            completed: false,
            category: String(args.category),
          } as T;
        }
        return {
          _id: String(args.id),
          title: "Measure gate",
          completed: true,
          category: "work",
        } as T;
      },
    };

    const provider = new ConvexPersistence(mock);
    assert.deepEqual(await provider.listTasks(), [
      { id: "task-1", title: "Measure gate", completed: false, category: "work" },
    ]);
    assert.equal((await provider.addTask("Load tools", "work")).id, "task-2");
    assert.equal((await provider.completeTask("task-1"))?.completed, true);
    assert.deepEqual(calls, [
      { reference: taskFunctions.create, args: { title: "Load tools", category: "work" } },
      { reference: taskFunctions.update, args: { id: "task-1", completed: true } },
    ]);
  });

  it("maps Convex reminder rows and removes by durable id", async () => {
    const calls: Array<{ reference: unknown; args: Record<string, unknown> }> = [];
    const mock: ConvexClientLike = {
      async query<T>(reference: unknown, args?: Record<string, unknown>) {
        assert.equal(reference, reminderFunctions.list);
        assert.deepEqual(args, {});
        return [{ _id: "reminder-1", title: "Call Claire", due: "tomorrow" }] as T;
      },
      async mutation<T>(reference: unknown, args: Record<string, unknown>) {
        calls.push({ reference, args });
        if (reference === reminderFunctions.create) {
          return { _id: "reminder-2", title: String(args.title), due: args.due } as T;
        }
        return true as T;
      },
    };

    const provider = new ConvexPersistence(mock);
    assert.deepEqual(await provider.listReminders(), [
      { id: "reminder-1", title: "Call Claire", due: "tomorrow" },
    ]);
    assert.equal((await provider.addReminder("Send invoice", "Friday")).id, "reminder-2");
    assert.equal(await provider.removeReminder("reminder-1"), true);
    assert.deepEqual(calls, [
      {
        reference: reminderFunctions.create,
        args: { title: "Send invoice", due: "Friday" },
      },
      { reference: reminderFunctions.remove, args: { id: "reminder-1" } },
    ]);
  });
});
