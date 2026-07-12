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
  normalizeDocument,
  reminderFunctions,
  taskFunctions,
  type AssistantState,
  type ConvexClientLike,
} from "../src/persistence/persistence.js";

const originalProvider = process.env.PERSISTENCE_PROVIDER;
const originalUrl = process.env.CONVEX_URL;
const originalToken = process.env.CONVEX_AUTH_TOKEN;
let tempDir = "";

beforeEach(async () => {
  delete process.env.PERSISTENCE_PROVIDER;
  delete process.env.CONVEX_URL;
  delete process.env.CONVEX_AUTH_TOKEN;
  tempDir = await fs.mkdtemp(path.join(os.tmpdir(), "jarvis-persistence-"));
});

afterEach(async () => {
  if (originalProvider === undefined) delete process.env.PERSISTENCE_PROVIDER;
  else process.env.PERSISTENCE_PROVIDER = originalProvider;
  if (originalUrl === undefined) delete process.env.CONVEX_URL;
  else process.env.CONVEX_URL = originalUrl;
  if (originalToken === undefined) delete process.env.CONVEX_AUTH_TOKEN;
  else process.env.CONVEX_AUTH_TOKEN = originalToken;
  await fs.rm(tempDir, { recursive: true, force: true });
});

describe("JSONPersistence", () => {
  it("returns empty durable collections when the file is missing", async () => {
    const provider = new JSONPersistence(path.join(tempDir, "missing.json"));
    assert.deepEqual(await provider.loadState(), {});
    assert.deepEqual(await provider.listTasks(), []);
    assert.deepEqual(await provider.listReminders(), []);
  });

  it("saves state, tasks, and reminders in one versioned document", async () => {
    const file = path.join(tempDir, "state.json");
    const provider = new JSONPersistence(file);
    const sample = { lastIntent: "testing", lastInput: "hi" };
    const task = await provider.addTask("Call Claire", "personal");
    const reminder = await provider.addReminder("Quote follow-up", "Friday 9am");
    await provider.saveState(sample);

    const reloaded = new JSONPersistence(file);
    assert.deepEqual(await reloaded.loadState(), sample);
    assert.deepEqual(await reloaded.listTasks(), [task]);
    assert.deepEqual(await reloaded.listReminders(), [reminder]);

    const stored = JSON.parse(await fs.readFile(file, "utf8")) as { version: number };
    assert.equal(stored.version, 1);
    const files = await fs.readdir(tempDir);
    assert.equal(files.some((name) => name.includes(".tmp-")), false);
  });

  it("migrates the original unversioned state without rewriting it on startup", async () => {
    const file = path.join(tempDir, "legacy.json");
    const legacy = { lastIntent: "greeting", lastInput: "Hello Jarvis" };
    const raw = JSON.stringify(legacy, null, 2);
    await fs.writeFile(file, raw, "utf8");

    const provider = new JSONPersistence(file);
    assert.deepEqual(await provider.loadState(), legacy);
    assert.equal(await fs.readFile(file, "utf8"), raw);
  });

  it("preserves task and reminder rows from a legacy document", () => {
    const migrated = normalizeDocument({
      state: { retained: true },
      tasks: [{ id: "task-1", title: "Old task", completed: false }],
      reminders: [{ id: "reminder-1", title: "Old reminder", due: "Monday" }],
    });
    assert.equal(migrated.tasks[0].category, "personal");
    assert.equal(migrated.tasks[0].createdAt, 0);
    assert.equal(migrated.reminders[0].createdAt, 0);
    assert.deepEqual(migrated.state, { retained: true });
  });

  it("moves malformed JSON aside and starts empty without bricking the CLI", async () => {
    const file = path.join(tempDir, "bad.json");
    const warnings: string[] = [];
    await fs.writeFile(file, "{not json", "utf8");
    const provider = new JSONPersistence(file, (message) => warnings.push(message));

    assert.deepEqual(await provider.loadState(), {});
    assert.equal(warnings.length, 1);
    const files = await fs.readdir(tempDir);
    const corrupt = files.find((name) => name.startsWith("bad.json.corrupt-"));
    assert(corrupt);
    assert.equal(await fs.readFile(path.join(tempDir, corrupt), "utf8"), "{not json");
  });

  it("rejects unknown versions and malformed version 1 rows instead of coercing them", () => {
    assert.throws(
      () => normalizeDocument({ version: 2, state: {}, tasks: [], reminders: [] }),
      /Unsupported state document version/,
    );
    assert.throws(
      () => normalizeDocument({ version: 1, state: "bad", tasks: [], reminders: [] }),
      /state must be an object/,
    );
    assert.throws(
      () =>
        normalizeDocument({
          version: 1,
          state: {},
          tasks: [{ id: "task-1", title: "Broken", completed: false }],
          reminders: [],
        }),
      /category/,
    );
  });

  it("returns null for malformed or missing task and reminder IDs", async () => {
    const provider = new JSONPersistence(path.join(tempDir, "state.json"));
    await provider.addTask("Real task", "personal");
    await provider.addReminder("Real reminder", "tomorrow");
    assert.equal(await provider.completeTask("garbage"), null);
    assert.equal(await provider.removeReminder("garbage"), null);
  });
});

describe("createPersistenceFromEnv", () => {
  it("defaults to JSON", () => {
    assert(createPersistenceFromEnv() instanceof JSONPersistence);
  });

  it("selects Convex with an injected client and no real URL or token", () => {
    process.env.PERSISTENCE_PROVIDER = "convex";
    const mock: ConvexClientLike = {
      async query<T>() {
        return null as T;
      },
      async mutation<T>() {
        return undefined as T;
      },
    };
    assert(createPersistenceFromEnv(mock) instanceof ConvexPersistence);
  });

  it("requires both the Convex URL and an identity token for a real client", () => {
    process.env.PERSISTENCE_PROVIDER = "convex";
    assert.throws(() => createPersistenceFromEnv(), /CONVEX_URL/);
    process.env.CONVEX_URL = "https://example.convex.cloud";
    assert.throws(() => createPersistenceFromEnv(), /CONVEX_AUTH_TOKEN/);
  });

  it("rejects unknown provider names", () => {
    process.env.PERSISTENCE_PROVIDER = "sqlite";
    assert.throws(() => createPersistenceFromEnv(), /Invalid PERSISTENCE_PROVIDER/);
  });
});

describe("ConvexPersistence", () => {
  it("loads and saves assistant state using the wrapped payload", async () => {
    const sample: AssistantState = { lastIntent: "hello" };
    const events: string[] = [];
    const mock: ConvexClientLike = {
      async query<T>(reference: unknown, args?: Record<string, unknown>) {
        assert.equal(reference, assistantStateFunctions.get);
        assert.deepEqual(args, {});
        events.push("load");
        return { state: sample } as T;
      },
      async mutation<T>(reference: unknown, args: Record<string, unknown>) {
        assert.equal(reference, assistantStateFunctions.upsert);
        assert.deepEqual(args, { state: sample });
        events.push("save");
        return undefined as T;
      },
    };
    const provider = new ConvexPersistence(mock);
    assert.deepEqual(await provider.loadState(), sample);
    await provider.saveState(sample);
    assert.deepEqual(events, ["load", "save"]);
  });

  it("maps task and reminder records through the shared provider contract", async () => {
    const mock: ConvexClientLike = {
      async query<T>(reference: unknown) {
        if (reference === taskFunctions.list) {
          return [
            {
              _id: "task-id",
              title: "Task",
              completed: false,
              category: "personal",
              createdAt: 1,
            },
          ] as T;
        }
        if (reference === reminderFunctions.list) {
          return [{ _id: "reminder-id", title: "Reminder", due: "Friday", createdAt: 2 }] as T;
        }
        return null as T;
      },
      async mutation<T>(reference: unknown) {
        if (reference === taskFunctions.create || reference === taskFunctions.complete) {
          return {
            _id: "task-id",
            title: "Task",
            completed: reference === taskFunctions.complete,
            category: "personal",
            createdAt: 1,
          } as T;
        }
        return { _id: "reminder-id", title: "Reminder", due: "Friday", createdAt: 2 } as T;
      },
    };
    const provider = new ConvexPersistence(mock);
    assert.equal((await provider.listTasks())[0].id, "task-id");
    assert.equal((await provider.addTask("Task", "personal")).title, "Task");
    assert.equal((await provider.completeTask("task-id"))?.completed, true);
    assert.equal((await provider.listReminders())[0].id, "reminder-id");
    assert.equal((await provider.addReminder("Reminder", "Friday")).due, "Friday");
    assert.equal((await provider.removeReminder("reminder-id"))?.title, "Reminder");
  });

  it("normalises legacy Convex invalid-ID failures to null", async () => {
    const mock: ConvexClientLike = {
      async query<T>() {
        return [] as T;
      },
      async mutation<T>() {
        throw new Error("ArgumentValidationError: invalid Convex ID");
      },
    };
    const provider = new ConvexPersistence(mock);
    assert.equal(await provider.completeTask("garbage"), null);
    assert.equal(await provider.removeReminder("garbage"), null);
  });
});
