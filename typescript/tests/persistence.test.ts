import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { once } from "node:events";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, beforeEach, describe, it } from "node:test";

import { getFunctionName } from "convex/server";

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

type ConvexStub = {
  query(reference: unknown, args?: Record<string, unknown>): Promise<unknown>;
  mutation(reference: unknown, args: Record<string, unknown>): Promise<unknown>;
};

function asConvexClient(stub: ConvexStub): ConvexClientLike {
  return stub as ConvexClientLike;
}

function convexFunctionName(reference: unknown): string {
  return getFunctionName(reference as Parameters<typeof getFunctionName>[0]);
}

async function runJsonWriter(file: string, title: string): Promise<void> {
  const script = fileURLToPath(new URL("fixtures/jsonWriter.ts", import.meta.url));
  const child = spawn(process.execPath, ["--import", "tsx", script, file, title], {
    stdio: ["ignore", "ignore", "pipe"],
  });
  let stderr = "";
  child.stderr?.setEncoding("utf8");
  child.stderr?.on("data", (chunk: string) => {
    stderr += chunk;
  });
  const [code, signal] = await once(child, "exit");
  assert.equal(code, 0, `JSON writer exited with ${String(signal)}: ${stderr}`);
}

const originalProvider = process.env.PERSISTENCE_PROVIDER;
const originalUrl = process.env.CONVEX_URL;
const originalToken = process.env.JARVIS_SERVICE_TOKEN;
let tempDir = "";

beforeEach(async () => {
  delete process.env.PERSISTENCE_PROVIDER;
  delete process.env.CONVEX_URL;
  delete process.env.JARVIS_SERVICE_TOKEN;
  tempDir = await fs.mkdtemp(path.join(os.tmpdir(), "jarvis-persistence-"));
});

afterEach(async () => {
  if (originalProvider === undefined) delete process.env.PERSISTENCE_PROVIDER;
  else process.env.PERSISTENCE_PROVIDER = originalProvider;
  if (originalUrl === undefined) delete process.env.CONVEX_URL;
  else process.env.CONVEX_URL = originalUrl;
  if (originalToken === undefined) delete process.env.JARVIS_SERVICE_TOKEN;
  else process.env.JARVIS_SERVICE_TOKEN = originalToken;
  await fs.rm(tempDir, { recursive: true, force: true });
});

describe("JSONPersistence", () => {
  it("returns empty durable collections when the file is missing", async () => {
    const provider = new JSONPersistence(path.join(tempDir, "missing.json"));
    assert.deepEqual(await provider.loadState(), {});
    assert.deepEqual(await provider.listTasks(), []);
    assert.deepEqual(await provider.listReminders(), []);
  });

  it("saves normalized reminder due data in the current versioned document", async () => {
    const file = path.join(tempDir, "state.json");
    const provider = new JSONPersistence(file);
    const sample = { lastIntent: "testing", lastInput: "hi" };
    const task = await provider.addTask("Call Claire", "personal");
    const reminder = await provider.addReminder("Quote follow-up", {
      raw: "Friday 9am",
      at: Date.parse("2026-07-16T23:00:00.000Z"),
      timezone: "Australia/Melbourne",
    });
    await provider.saveState(sample);

    const reloaded = new JSONPersistence(file);
    assert.deepEqual(await reloaded.loadState(), sample);
    assert.deepEqual(await reloaded.listTasks(), [task]);
    assert.deepEqual(await reloaded.listReminders(), [reminder]);

    const stored = JSON.parse(await fs.readFile(file, "utf8")) as {
      version: number;
      reminders: Array<Record<string, unknown>>;
    };
    assert.equal(stored.version, 2);
    assert.equal(stored.reminders[0].dueRaw, "Friday 9am");
    assert.equal(stored.reminders[0].dueAt, Date.parse("2026-07-16T23:00:00.000Z"));
    assert.equal(stored.reminders[0].dueTimezone, "Australia/Melbourne");
    assert.equal("due" in stored.reminders[0], false);
    const files = await fs.readdir(tempDir);
    assert.equal(
      files.some((name) => name.includes(".tmp-")),
      false,
    );
    assert.equal(
      files.some((name) => name.endsWith(".lock")),
      false,
    );
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

  it("preserves task and reminder rows from unversioned and version 1 documents", () => {
    const migratedLegacy = normalizeDocument({
      state: { retained: true },
      tasks: [{ id: "task-1", title: "Old task", completed: false }],
      reminders: [{ id: "reminder-1", title: "Old reminder", due: "Monday" }],
    });
    assert.equal(migratedLegacy.tasks[0].category, "personal");
    assert.equal(migratedLegacy.tasks[0].createdAt, 0);
    assert.equal(migratedLegacy.reminders[0].createdAt, 0);
    assert.equal(migratedLegacy.reminders[0].dueRaw, "Monday");
    assert.deepEqual(migratedLegacy.state, { retained: true });

    const migratedVersion1 = normalizeDocument({
      version: 1,
      state: {},
      tasks: [],
      reminders: [
        { id: "reminder-2", title: "Verified backup reminder", due: "Friday 9am", createdAt: 2 },
      ],
    });
    assert.equal(migratedVersion1.reminders[0].dueRaw, "Friday 9am");
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

  it("rejects unknown versions and malformed current rows instead of coercing them", () => {
    assert.throws(
      () => normalizeDocument({ version: 3, state: {}, tasks: [], reminders: [] }),
      /Unsupported state document version/,
    );
    assert.throws(
      () => normalizeDocument({ version: 2, state: "bad", tasks: [], reminders: [] }),
      /state must be an object/,
    );
    assert.throws(
      () =>
        normalizeDocument({
          version: 2,
          state: {},
          tasks: [{ id: "task-1", title: "Broken", completed: false }],
          reminders: [],
        }),
      /category/,
    );
    assert.throws(
      () =>
        normalizeDocument({
          version: 2,
          state: {},
          tasks: [],
          reminders: [
            {
              id: "reminder-1",
              title: "Broken due",
              dueRaw: "Friday 9am",
              dueAt: 1,
              createdAt: 1,
            },
          ],
        }),
      /both dueAt and dueTimezone/,
    );
  });

  it("removes tasks durably and returns null for missing IDs", async () => {
    const provider = new JSONPersistence(path.join(tempDir, "state.json"));
    const task = await provider.addTask("Disposable task", "personal");
    assert.deepEqual(await provider.removeTask(task.id), task);
    assert.deepEqual(await provider.listTasks(), []);
    assert.equal(await provider.completeTask("garbage"), null);
    assert.equal(await provider.removeTask("garbage"), null);
    assert.equal(await provider.removeReminder("garbage"), null);
  });

  it("serializes writes and refreshes reads across provider instances", async () => {
    const file = path.join(tempDir, "shared.json");
    const first = new JSONPersistence(file);
    const second = new JSONPersistence(file);

    assert.deepEqual(await first.listTasks(), []);

    await Promise.all([
      first.addTask("First task", "personal"),
      second.addTask("Second task", "personal"),
      first.addReminder("First reminder", { raw: "Monday" }),
      second.addReminder("Second reminder", { raw: "Tuesday" }),
    ]);

    assert.deepEqual((await first.listTasks()).map((task) => task.title).sort(), [
      "First task",
      "Second task",
    ]);
    assert.deepEqual((await second.listReminders()).map((reminder) => reminder.title).sort(), [
      "First reminder",
      "Second reminder",
    ]);
    assert.equal(
      (await fs.readdir(tempDir)).some((name) => name.endsWith(".lock")),
      false,
    );
  });

  it("serializes writes from separate Node processes", async () => {
    const file = path.join(tempDir, "multi-process.json");
    const titles = ["Writer one", "Writer two", "Writer three", "Writer four"];

    await Promise.all(titles.map((title) => runJsonWriter(file, title)));

    assert.deepEqual(
      (await new JSONPersistence(file).listTasks()).map((task) => task.title).sort(),
      [...titles].sort(),
    );
    assert.equal(
      (await fs.readdir(tempDir)).some((name) => name.includes(".lock.tmp-")),
      false,
    );
  });

  it("times out without deleting a fresh malformed lock", async () => {
    const file = path.join(tempDir, "fresh-malformed.json");
    await fs.writeFile(`${file}.lock`, "{", { mode: 0o600 });

    const provider = new JSONPersistence(file, () => undefined, 40);
    await assert.rejects(
      provider.addTask("Blocked task", "personal"),
      /locked by a malformed lock file/,
    );
    assert.equal(await fs.readFile(`${file}.lock`, "utf8"), "{");
  });

  it("reclaims a stale malformed lock left by an interrupted legacy writer", async () => {
    const file = path.join(tempDir, "stale-malformed.json");
    const lockPath = `${file}.lock`;
    const warnings: string[] = [];
    await fs.writeFile(lockPath, "{", { mode: 0o600 });
    const old = new Date(Date.now() - 5_000);
    await fs.utimes(lockPath, old, old);

    const provider = new JSONPersistence(file, (message) => warnings.push(message), 40);
    const task = await provider.addTask("Recovered malformed lock", "personal");

    assert.equal(task.title, "Recovered malformed lock");
    assert.match(warnings[0] ?? "", /reclaimed a stale malformed JSON state lock/);
    await assert.rejects(fs.access(lockPath), /ENOENT/);
  });

  it("times out with an actionable error while a live writer holds the lock", async () => {
    const file = path.join(tempDir, "locked.json");
    await fs.writeFile(
      `${file}.lock`,
      `${JSON.stringify({ pid: process.pid, acquiredAt: Date.now(), token: "held-by-test" })}\n`,
      { mode: 0o600 },
    );

    const provider = new JSONPersistence(file, () => undefined, 40);
    await assert.rejects(
      provider.addTask("Blocked task", "personal"),
      /locked by process .*Close the other local writer or select Convex/,
    );
  });

  it("reclaims a lock left by a process that has exited", async () => {
    const file = path.join(tempDir, "stale.json");
    const child = spawn(process.execPath, ["-e", "process.exit(0)"], { stdio: "ignore" });
    if (child.pid === undefined) throw new Error("Failed to start stale-lock test process.");
    const childPid = child.pid;
    await once(child, "exit");

    await fs.writeFile(
      `${file}.lock`,
      `${JSON.stringify({ pid: childPid, acquiredAt: Date.now(), token: "stale-test-lock" })}\n`,
      { mode: 0o600 },
    );

    const warnings: string[] = [];
    const provider = new JSONPersistence(file, (message) => warnings.push(message), 250);
    const task = await provider.addTask("Recovered task", "personal");

    assert.equal(task.title, "Recovered task");
    assert.match(warnings[0] ?? "", /reclaimed a stale JSON state lock/);
    assert.equal(
      (await fs.readdir(tempDir)).some((name) => name.endsWith(".lock")),
      false,
    );
  });
});

describe("createPersistenceFromEnv", () => {
  it("defaults to JSON", () => {
    assert(createPersistenceFromEnv() instanceof JSONPersistence);
  });

  it("selects Convex with an injected client and service token", () => {
    process.env.PERSISTENCE_PROVIDER = "convex";
    process.env.JARVIS_SERVICE_TOKEN = "test-service-token";
    const mock = asConvexClient({
      async query() {
        return null;
      },
      async mutation() {
        return null;
      },
    });
    assert(createPersistenceFromEnv(mock) instanceof ConvexPersistence);
  });

  it("requires both a service token and Convex URL for a real client", () => {
    process.env.PERSISTENCE_PROVIDER = "convex";
    assert.throws(() => createPersistenceFromEnv(), /JARVIS_SERVICE_TOKEN/);
    process.env.JARVIS_SERVICE_TOKEN = "test-service-token";
    assert.throws(() => createPersistenceFromEnv(), /CONVEX_URL/);
  });

  it("rejects unknown provider names", () => {
    process.env.PERSISTENCE_PROVIDER = "sqlite";
    assert.throws(() => createPersistenceFromEnv(), /Invalid PERSISTENCE_PROVIDER/);
  });
});

describe("ConvexPersistence", () => {
  it("loads and saves assistant state with generated API references", async () => {
    const sample: AssistantState = { lastIntent: "hello" };
    const events: string[] = [];
    const mock = asConvexClient({
      async query(reference, args) {
        assert.equal(
          convexFunctionName(reference),
          convexFunctionName(assistantStateFunctions.get),
        );
        assert.deepEqual(args, { serviceToken: "test-service-token" });
        events.push("load");
        return { state: sample };
      },
      async mutation(reference, args) {
        assert.equal(
          convexFunctionName(reference),
          convexFunctionName(assistantStateFunctions.upsert),
        );
        assert.deepEqual(args, { serviceToken: "test-service-token", state: sample });
        events.push("save");
        return "assistant-state-id";
      },
    });
    const provider = new ConvexPersistence(mock, "test-service-token");
    assert.deepEqual(await provider.loadState(), sample);
    await provider.saveState(sample);
    assert.deepEqual(events, ["load", "save"]);
  });

  it("maps legacy and normalized reminder records through the generated provider contract", async () => {
    const normalizedAt = Date.parse("2026-07-16T23:00:00.000Z");
    const mock = asConvexClient({
      async query(reference, args) {
        assert.equal(args?.serviceToken, "test-service-token");
        if (convexFunctionName(reference) === convexFunctionName(taskFunctions.list)) {
          return [
            {
              _id: "task-id",
              _creationTime: 1,
              ownerId: "jarvis-cli",
              title: "Task",
              completed: false,
              category: "personal",
              createdAt: 1,
            },
          ];
        }
        if (convexFunctionName(reference) === convexFunctionName(reminderFunctions.list)) {
          return [
            {
              _id: "legacy-reminder-id",
              _creationTime: 2,
              ownerId: "jarvis-cli",
              title: "Legacy reminder",
              due: "Friday",
              createdAt: 2,
            },
          ];
        }
        return null;
      },
      async mutation(reference, args) {
        assert.equal(args.serviceToken, "test-service-token");
        const functionName = convexFunctionName(reference);
        if (
          functionName === convexFunctionName(taskFunctions.create) ||
          functionName === convexFunctionName(taskFunctions.complete) ||
          functionName === convexFunctionName(taskFunctions.remove)
        ) {
          return {
            _id: "task-id",
            _creationTime: 1,
            ownerId: "jarvis-cli",
            title: "Task",
            completed: functionName === convexFunctionName(taskFunctions.complete),
            category: "personal",
            createdAt: 1,
          };
        }
        if (functionName === convexFunctionName(reminderFunctions.create)) {
          assert.deepEqual(args, {
            serviceToken: "test-service-token",
            title: "Reminder",
            dueRaw: "Friday 9am",
            dueAt: normalizedAt,
            dueTimezone: "Australia/Melbourne",
          });
        }
        return {
          _id: "reminder-id",
          _creationTime: 2,
          ownerId: "jarvis-cli",
          title: "Reminder",
          dueRaw: "Friday 9am",
          dueAt: normalizedAt,
          dueTimezone: "Australia/Melbourne",
          createdAt: 2,
        };
      },
    });
    const provider = new ConvexPersistence(mock, "test-service-token");
    assert.equal((await provider.listTasks())[0].id, "task-id");
    assert.equal((await provider.addTask("Task", "personal")).title, "Task");
    assert.equal((await provider.completeTask("task-id"))?.completed, true);
    assert.equal((await provider.removeTask("task-id"))?.title, "Task");
    assert.equal((await provider.listReminders())[0].dueRaw, "Friday");
    const added = await provider.addReminder("Reminder", {
      raw: "Friday 9am",
      at: normalizedAt,
      timezone: "Australia/Melbourne",
    });
    assert.equal(added.dueRaw, "Friday 9am");
    assert.equal(added.dueAt, normalizedAt);
    assert.equal((await provider.removeReminder("reminder-id"))?.title, "Reminder");
  });

  it("treats malformed assistant state returned by Convex as empty", async () => {
    const mock = asConvexClient({
      async query() {
        return { state: "not-an-object" };
      },
      async mutation() {
        return null;
      },
    });
    const provider = new ConvexPersistence(mock, "test-service-token");
    assert.deepEqual(await provider.loadState(), {});
  });

  it("normalises legacy Convex invalid-ID failures to null", async () => {
    const mock = asConvexClient({
      async query() {
        return [];
      },
      async mutation() {
        throw new Error("ArgumentValidationError: invalid Convex ID");
      },
    });
    const provider = new ConvexPersistence(mock, "test-service-token");
    assert.equal(await provider.completeTask("garbage"), null);
    assert.equal(await provider.removeTask("garbage"), null);
    assert.equal(await provider.removeReminder("garbage"), null);
  });

  it("does not hide unrelated Convex argument validation failures as missing IDs", async () => {
    const provider = new ConvexPersistence(
      asConvexClient({
        async query() {
          return [];
        },
        async mutation() {
          throw new Error("ArgumentValidationError: object contains an unexpected field");
        },
      }),
      "test-service-token",
    );

    await assert.rejects(
      provider.updateTask("task-id", { title: "Updated title" }),
      /unexpected field/,
    );
  });
});
