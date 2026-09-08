import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, it } from "node:test";

import { getFunctionName } from "convex/server";

import {
  exportBackup,
  parseBackup,
  readBackupFile,
  restoreBackupIntoEmptyProvider,
  verifyBackupRestore,
  writeBackupFile,
  type BackupMemoryStores,
} from "../src/backup/backup.js";
import {
  ConvexPersistence,
  JSONPersistence,
  assistantStateFunctions,
  type AssistantState,
  type ConvexClientLike,
  type PersistenceProvider,
  type PersistenceRestoreResult,
  type PersistenceSnapshot,
  type Reminder,
  type ReminderDue,
  type ReminderUpdate,
  type Task,
  type TaskUpdate,
} from "../src/persistence/persistence.js";
import { InMemoryBuildStore } from "../src/builds/inMemoryBuildStore.js";
import { InMemoryBuildLogStore } from "../src/buildLog/inMemoryBuildLogStore.js";
import { InMemoryUpgradeStore } from "../src/upgrades/inMemoryUpgradeStore.js";
import { InMemoryAssetStore } from "../src/assets/inMemoryAssetStore.js";
import { InMemoryPreferenceStore } from "../src/preferences/inMemoryPreferenceStore.js";
import { JsonBuildStore } from "../src/builds/jsonBuildStore.js";
import { JsonBuildLogStore } from "../src/buildLog/jsonBuildLogStore.js";
import { JsonUpgradeStore } from "../src/upgrades/jsonUpgradeStore.js";
import { JsonAssetStore } from "../src/assets/jsonAssetStore.js";
import { JsonPreferenceStore } from "../src/preferences/jsonPreferenceStore.js";

function emptyMemoryStores(): BackupMemoryStores {
  return {
    builds: new InMemoryBuildStore(),
    buildLogs: new InMemoryBuildLogStore(),
    upgrades: new InMemoryUpgradeStore(),
    assets: new InMemoryAssetStore(),
    preferences: new InMemoryPreferenceStore(),
  };
}

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
  tempDir = await fs.mkdtemp(path.join(os.tmpdir(), "jarvis-backup-test-"));
});

afterEach(async () => {
  await fs.rm(tempDir, { recursive: true, force: true });
});

class InMemoryAtomicProvider implements PersistenceProvider {
  state: AssistantState = {};
  tasks: Task[] = [];
  reminders: Reminder[] = [];

  async loadState(): Promise<AssistantState> {
    return { ...this.state };
  }

  async saveState(state: AssistantState): Promise<void> {
    this.state = { ...state };
  }

  async listTasks(): Promise<Task[]> {
    return this.tasks.map((task) => ({ ...task }));
  }

  async addTask(title: string, category: string): Promise<Task> {
    const task: Task = {
      id: `task-${this.tasks.length + 1}`,
      title,
      completed: false,
      category,
      createdAt: Date.now(),
    };
    this.tasks.push(task);
    return { ...task };
  }

  async updateTask(_id: string, _update: TaskUpdate): Promise<Task | null> {
    return null;
  }

  async completeTask(id: string): Promise<Task | null> {
    const task = this.tasks.find((entry) => entry.id === id);
    if (!task) return null;
    task.completed = true;
    return { ...task };
  }

  async removeTask(id: string): Promise<Task | null> {
    const index = this.tasks.findIndex((entry) => entry.id === id);
    if (index < 0) return null;
    const [task] = this.tasks.splice(index, 1);
    return { ...task };
  }

  async listReminders(): Promise<Reminder[]> {
    return this.reminders.map((reminder) => ({ ...reminder }));
  }

  async addReminder(title: string, due?: ReminderDue): Promise<Reminder> {
    const reminder: Reminder = {
      id: `reminder-${this.reminders.length + 1}`,
      title,
      ...(due === undefined
        ? {}
        : {
            dueRaw: due.raw,
            ...(due.at === undefined ? {} : { dueAt: due.at, dueTimezone: due.timezone as string }),
          }),
      createdAt: Date.now(),
    };
    this.reminders.push(reminder);
    return { ...reminder };
  }

  async updateReminder(_id: string, _update: ReminderUpdate): Promise<Reminder | null> {
    return null;
  }

  async removeReminder(id: string): Promise<Reminder | null> {
    const index = this.reminders.findIndex((entry) => entry.id === id);
    if (index < 0) return null;
    const [reminder] = this.reminders.splice(index, 1);
    return { ...reminder };
  }

  async snapshot(): Promise<PersistenceSnapshot> {
    return {
      state: { ...this.state },
      tasks: this.tasks.map((task) => ({ ...task })),
      reminders: this.reminders.map((reminder) => ({ ...reminder })),
    };
  }

  async restoreSnapshotIntoEmpty(
    _snapshot: PersistenceSnapshot,
  ): Promise<PersistenceRestoreResult> {
    throw new Error("forced atomic restore failure");
  }
}

class SnapshotOnlyProvider extends InMemoryAtomicProvider {
  override async loadState(): Promise<AssistantState> {
    throw new Error("export must not read state separately");
  }

  override async listTasks(): Promise<Task[]> {
    throw new Error("export must not read tasks separately");
  }

  override async listReminders(): Promise<Reminder[]> {
    throw new Error("export must not read reminders separately");
  }

  override async snapshot(): Promise<PersistenceSnapshot> {
    return {
      state: { coherent: true },
      tasks: [
        {
          id: "snapshot-task",
          title: "One coherent task",
          completed: false,
          category: "work",
          createdAt: 1,
        },
      ],
      reminders: [],
    };
  }
}

describe("Jarvis backup archives", () => {
  it("exports, writes, verifies, restores, and remaps normalized reminder data", async () => {
    const source = new JSONPersistence(path.join(tempDir, "source.json"));
    const pending = await source.addTask("Measure gate", "work");
    const completed = await source.addTask("Send invoice", "business");
    await source.completeTask(completed.id);
    const reminder = await source.addReminder("Call Claire", {
      raw: "Friday 9am",
      at: Date.parse("2026-07-16T23:00:00.000Z"),
      timezone: "Australia/Melbourne",
    });
    await source.saveState({
      lastTask: completed,
      lastReminder: reminder,
      nested: { ids: [pending.id, completed.id, reminder.id] },
    });

    const archive = await exportBackup(
      source,
      () => new Date("2026-07-13T03:30:00.000Z"),
      emptyMemoryStores(),
    );
    assert.equal(archive.version, 3);
    assert.equal(archive.createdAt, "2026-07-13T03:30:00.000Z");
    assert.equal(archive.tasks.length, 2);
    assert.equal(archive.reminders.length, 1);
    assert.equal(archive.reminders[0].dueRaw, "Friday 9am");
    assert.equal(archive.reminders[0].dueTimezone, "Australia/Melbourne");

    const backupPath = path.join(tempDir, "backups", "jarvis.json");
    await writeBackupFile(backupPath, archive);
    const loaded = await readBackupFile(backupPath);
    assert.deepEqual(loaded, archive);
    if (process.platform !== "win32") {
      const mode = (await fs.stat(backupPath)).mode & 0o777;
      assert.equal(mode, 0o600);
    }

    const isolated = await verifyBackupRestore(loaded);
    assert.equal(isolated.taskCount, 2);
    assert.equal(isolated.reminderCount, 1);

    const destination = new JSONPersistence(path.join(tempDir, "destination.json"));
    const result = await restoreBackupIntoEmptyProvider(destination, loaded);
    const restoredState = await destination.loadState();
    const restoredTasks = await destination.listTasks();
    const restoredReminders = await destination.listReminders();

    assert.equal(restoredTasks.length, 2);
    assert.equal(restoredTasks.find((task) => task.title === "Send invoice")?.completed, true);
    assert.equal(restoredReminders[0].dueRaw, "Friday 9am");
    assert.equal(restoredReminders[0].dueAt, Date.parse("2026-07-16T23:00:00.000Z"));
    assert.equal(restoredReminders[0].dueTimezone, "Australia/Melbourne");
    assert.equal((restoredState.lastTask as { id: string }).id, result.taskIds.get(completed.id));
    assert.equal(
      (restoredState.lastReminder as { id: string }).id,
      result.reminderIds.get(reminder.id),
    );
    assert.deepEqual((restoredState.nested as { ids: string[] }).ids, [
      result.taskIds.get(pending.id),
      result.taskIds.get(completed.id),
      result.reminderIds.get(reminder.id),
    ]);
  });

  it("exports from one provider snapshot rather than three independent reads", async () => {
    const archive = await exportBackup(
      new SnapshotOnlyProvider(),
      () => new Date("2026-07-13T03:30:00.000Z"),
      emptyMemoryStores(),
    );

    assert.deepEqual(archive.state, { coherent: true });
    assert.equal(archive.tasks[0].title, "One coherent task");
  });

  it("allows only one concurrent restore into the same JSON target", async () => {
    const source = new JSONPersistence(path.join(tempDir, "source-concurrent.json"));
    await source.addTask("Only one copy", "work");
    await source.addReminder("Only one reminder", { raw: "after Claire calls" });
    const archive = await exportBackup(source, undefined, emptyMemoryStores());
    const target = path.join(tempDir, "concurrent-target.json");

    const attempts = await Promise.allSettled([
      restoreBackupIntoEmptyProvider(new JSONPersistence(target), archive),
      restoreBackupIntoEmptyProvider(new JSONPersistence(target), archive),
    ]);

    assert.equal(attempts.filter((attempt) => attempt.status === "fulfilled").length, 1);
    const rejection = attempts.find(
      (attempt): attempt is PromiseRejectedResult => attempt.status === "rejected",
    );
    assert.match(String(rejection?.reason), /target provider is not empty/);
    assert.equal((await new JSONPersistence(target).listTasks()).length, 1);
    assert.equal((await new JSONPersistence(target).listReminders()).length, 1);
  });

  it("accepts a version 1 backup and preserves its free-form due text", () => {
    const migrated = parseBackup({
      format: "jarvis-backup",
      version: 1,
      createdAt: "2026-07-13T03:30:00.000Z",
      state: {},
      tasks: [],
      reminders: [
        {
          id: "legacy-reminder",
          title: "Legacy reminder",
          due: "after Claire calls",
          createdAt: 1,
        },
      ],
    });

    assert.equal(migrated.version, 3);
    assert.deepEqual(migrated.reminders[0], {
      id: "legacy-reminder",
      title: "Legacy reminder",
      dueRaw: "after Claire calls",
      createdAt: 1,
    });
  });

  it("refuses to overwrite an existing backup file", async () => {
    const provider = new JSONPersistence(path.join(tempDir, "source.json"));
    const archive = await exportBackup(provider, undefined, emptyMemoryStores());
    const backupPath = path.join(tempDir, "backup.json");
    await writeBackupFile(backupPath, archive);
    await assert.rejects(() => writeBackupFile(backupPath, archive), /already exists/);
  });

  it("refuses to create a version 3 archive without memory-domain stores", async () => {
    const provider = new JSONPersistence(path.join(tempDir, "source.json"));
    await assert.rejects(
      () => exportBackup(provider),
      /requires memory-domain stores.*incomplete version 3 archive/,
    );
  });

  it("refuses to read a backup through a symbolic link", async () => {
    if (process.platform === "win32") return;

    const provider = new JSONPersistence(path.join(tempDir, "source.json"));
    const archive = await exportBackup(provider, undefined, emptyMemoryStores());
    const realPath = path.join(tempDir, "real-backup.json");
    const linkPath = path.join(tempDir, "linked-backup.json");
    await writeBackupFile(realPath, archive);
    await fs.symlink(realPath, linkPath);

    await assert.rejects(() => readBackupFile(linkPath), /symbolic link|symlink/i);
  });

  it("refuses restore when the target contains state or records", async () => {
    const source = new JSONPersistence(path.join(tempDir, "source.json"));
    await source.addTask("Source task", "work");
    const archive = await exportBackup(source, undefined, emptyMemoryStores());

    const destination = new JSONPersistence(path.join(tempDir, "destination.json"));
    await destination.saveState({ occupied: true });
    await assert.rejects(
      () => restoreBackupIntoEmptyProvider(destination, archive),
      /target provider is not empty/,
    );
    assert.deepEqual(await destination.loadState(), { occupied: true });
  });

  it("leaves a target unchanged when its atomic restore fails", async () => {
    const archive = parseBackup({
      format: "jarvis-backup",
      version: 2,
      createdAt: "2026-07-13T03:30:00.000Z",
      state: { retained: true },
      tasks: [
        {
          id: "source-task",
          title: "Temporary task",
          completed: false,
          category: "work",
          createdAt: 1,
        },
      ],
      reminders: [],
    });
    const provider = new InMemoryAtomicProvider();

    await assert.rejects(
      () => restoreBackupIntoEmptyProvider(provider, archive),
      /forced atomic restore failure/,
    );
    assert.deepEqual(provider.tasks, []);
    assert.deepEqual(provider.reminders, []);
    assert.deepEqual(provider.state, {});
  });

  it("uses one Convex query and one Convex mutation for atomic backup operations", async () => {
    const calls: Array<{ name: string; args: Record<string, unknown> }> = [];
    const taskRow = {
      _id: "target-task",
      _creationTime: 1,
      ownerId: "jarvis-cli",
      title: "Convex task",
      completed: true,
      category: "work",
      createdAt: 2,
    };
    const reminderRow = {
      _id: "target-reminder",
      _creationTime: 3,
      ownerId: "jarvis-cli",
      title: "Convex reminder",
      dueRaw: "Friday 9am",
      createdAt: 4,
    };
    const client = asConvexClient({
      async query(reference, args) {
        calls.push({ name: functionName(reference), args: args ?? {} });
        return { state: { taskId: "source-task" }, tasks: [taskRow], reminders: [reminderRow] };
      },
      async mutation(reference, args) {
        calls.push({ name: functionName(reference), args });
        return {
          state: { taskId: "target-task", reminderId: "target-reminder" },
          tasks: [taskRow],
          reminders: [reminderRow],
          taskIds: [{ sourceId: "source-task", targetId: "target-task" }],
          reminderIds: [{ sourceId: "source-reminder", targetId: "target-reminder" }],
        };
      },
    });
    const provider = new ConvexPersistence(client, "test-token");

    const snapshot = await provider.snapshot();
    assert.equal(snapshot.tasks[0].id, "target-task");
    const restored = await provider.restoreSnapshotIntoEmpty({
      state: { taskId: "source-task", reminderId: "source-reminder" },
      tasks: [
        {
          id: "source-task",
          title: "Convex task",
          completed: true,
          category: "work",
          createdAt: 1,
        },
      ],
      reminders: [
        {
          id: "source-reminder",
          title: "Convex reminder",
          dueRaw: "Friday 9am",
          createdAt: 1,
        },
      ],
    });

    assert.equal(restored.taskIds.get("source-task"), "target-task");
    assert.equal(restored.reminderIds.get("source-reminder"), "target-reminder");
    assert.deepEqual(calls, [
      {
        name: functionName(assistantStateFunctions.snapshot),
        args: { serviceToken: "test-token" },
      },
      {
        name: functionName(assistantStateFunctions.restoreEmpty),
        args: {
          serviceToken: "test-token",
          state: { taskId: "source-task", reminderId: "source-reminder" },
          tasks: [
            {
              sourceId: "source-task",
              title: "Convex task",
              completed: true,
              category: "work",
            },
          ],
          reminders: [
            {
              sourceId: "source-reminder",
              title: "Convex reminder",
              dueRaw: "Friday 9am",
            },
          ],
        },
      },
    ]);
  });

  it("rejects unsupported versions, malformed due values, and duplicate record IDs", () => {
    assert.throws(
      () =>
        parseBackup({
          format: "jarvis-backup",
          version: 4,
          createdAt: "2026-07-13T03:30:00.000Z",
          state: {},
          tasks: [],
          reminders: [],
        }),
      /Unsupported backup version/,
    );
    assert.throws(
      () =>
        parseBackup({
          format: "jarvis-backup",
          version: 2,
          createdAt: "2026-07-13T03:30:00.000Z",
          state: {},
          tasks: [],
          reminders: [
            {
              id: "bad-reminder",
              title: "Bad reminder",
              dueRaw: "Friday 9am",
              dueAt: 1,
              createdAt: 1,
            },
          ],
        }),
      /both dueAt and dueTimezone/,
    );
    assert.throws(
      () =>
        parseBackup({
          format: "jarvis-backup",
          version: 2,
          createdAt: "2026-07-13T03:30:00.000Z",
          state: {},
          tasks: [],
          reminders: [
            {
              id: "bad-timezone",
              title: "Bad timezone",
              dueRaw: "Friday 9am",
              dueAt: 1,
              dueTimezone: "UTC+15:00",
              createdAt: 1,
            },
          ],
        }),
      /Invalid reminder due timezone/,
    );
    assert.throws(
      () =>
        parseBackup({
          format: "jarvis-backup",
          version: 2,
          createdAt: "2026-07-13T03:30:00.000Z",
          state: {},
          tasks: [
            { id: "duplicate", title: "One", completed: false, category: "work", createdAt: 1 },
            { id: "duplicate", title: "Two", completed: false, category: "work", createdAt: 2 },
          ],
          reminders: [],
        }),
      /duplicate task id/,
    );
  });

  describe("memory store domains (builds, build logs, upgrades, assets, preferences)", () => {
    it("round-trips all five domains, remapping buildId to the restored build's new id", async () => {
      const source = new JSONPersistence(path.join(tempDir, "source.json"));
      await source.addTask("Measure gate", "work");
      const sourceMemory = emptyMemoryStores();
      const build = await sourceMemory.builds.add({
        name: "Trailer",
        kind: "shed",
        status: "active",
        description: "gull-wing",
      });
      await sourceMemory.buildLogs.add({
        buildId: build.id,
        title: "First weld",
        kind: "milestone",
        body: "went well",
        occurredAt: 1000,
      });
      await sourceMemory.upgrades.add({
        buildId: build.id,
        title: "New axle",
        reason: "stronger",
        parts: ["axle", "hub"],
      });
      await sourceMemory.assets.add({
        name: "Angle grinder",
        kind: "tool",
        serviceIntervalDays: 60,
      });
      await sourceMemory.preferences.add({ key: "paint-brand", value: "Dulux", category: "paint" });

      const archive = await exportBackup(
        source,
        () => new Date("2026-07-13T03:30:00.000Z"),
        sourceMemory,
      );
      assert.equal(archive.version, 3);
      assert.equal(archive.builds.length, 1);
      assert.equal(archive.buildLogs.length, 1);
      assert.equal(archive.upgrades.length, 1);
      assert.equal(archive.assets.length, 1);
      assert.equal(archive.preferences.length, 1);

      const backupPath = path.join(tempDir, "backup.json");
      await writeBackupFile(backupPath, archive);
      const loaded = await readBackupFile(backupPath);
      assert.deepEqual(loaded, archive);

      const isolated = await verifyBackupRestore(loaded);
      assert.equal(isolated.buildCount, 1);
      assert.equal(isolated.buildLogCount, 1);
      assert.equal(isolated.upgradeCount, 1);
      assert.equal(isolated.assetCount, 1);
      assert.equal(isolated.preferenceCount, 1);

      const destination = new JSONPersistence(path.join(tempDir, "destination.json"));
      const destinationMemory = emptyMemoryStores();
      const result = await restoreBackupIntoEmptyProvider(destination, loaded, destinationMemory);

      const restoredBuilds = await destinationMemory.builds.list();
      const restoredBuildLogs = await destinationMemory.buildLogs.list();
      const restoredUpgrades = await destinationMemory.upgrades.list();
      const restoredAssets = await destinationMemory.assets.list();
      const restoredPreferences = await destinationMemory.preferences.list();

      assert.equal(restoredBuilds.length, 1);
      assert.notEqual(restoredBuilds[0]?.id, build.id);
      assert.equal(result.buildIds.get(build.id), restoredBuilds[0]?.id);
      assert.equal(restoredBuildLogs[0]?.buildId, restoredBuilds[0]?.id);
      assert.equal(restoredUpgrades[0]?.buildId, restoredBuilds[0]?.id);
      assert.deepEqual(restoredUpgrades[0]?.parts, ["axle", "hub"]);
      assert.equal(restoredAssets[0]?.serviceIntervalDays, 60);
      assert.equal(restoredPreferences[0]?.category, "paint");
    });

    it("keeps a v2 archive restorable without supplying memory stores", async () => {
      const archive = parseBackup({
        format: "jarvis-backup",
        version: 2,
        createdAt: "2026-07-13T03:30:00.000Z",
        state: {},
        tasks: [],
        reminders: [],
      });
      assert.deepEqual(archive.builds, []);

      const destination = new JSONPersistence(path.join(tempDir, "destination.json"));
      const result = await restoreBackupIntoEmptyProvider(destination, archive);
      assert.equal(result.buildCount, 0);
    });

    it("refuses restore when the archive holds memory records but no memory stores are supplied", async () => {
      const source = new JSONPersistence(path.join(tempDir, "source.json"));
      const sourceMemory = emptyMemoryStores();
      await sourceMemory.preferences.add({ key: "paint-brand", value: "Dulux" });
      const archive = await exportBackup(source, undefined, sourceMemory);

      const destination = new JSONPersistence(path.join(tempDir, "destination.json"));
      await assert.rejects(
        () => restoreBackupIntoEmptyProvider(destination, archive),
        /no memory stores were supplied/,
      );
      // Nothing in the core provider should have been written either.
      assert.deepEqual(await destination.loadState(), {});
    });

    it("refuses restore when a target memory store is not empty", async () => {
      const source = new JSONPersistence(path.join(tempDir, "source.json"));
      const sourceMemory = emptyMemoryStores();
      await sourceMemory.assets.add({ name: "Angle grinder", kind: "tool" });
      const archive = await exportBackup(source, undefined, sourceMemory);

      const destination = new JSONPersistence(path.join(tempDir, "destination.json"));
      const destinationMemory = emptyMemoryStores();
      await destinationMemory.preferences.add({ key: "existing", value: "already here" });

      await assert.rejects(
        () => restoreBackupIntoEmptyProvider(destination, archive, destinationMemory),
        /target preference store is not empty/,
      );
      // The core provider must not have been touched either — the pre-check runs first.
      assert.deepEqual(await destination.loadState(), {});
      assert.equal((await destination.listTasks()).length, 0);
    });

    it("rejects a build log or upgrade whose buildId does not match any build in the archive", () => {
      assert.throws(
        () =>
          parseBackup({
            format: "jarvis-backup",
            version: 3,
            createdAt: "2026-07-13T03:30:00.000Z",
            state: {},
            tasks: [],
            reminders: [],
            builds: [],
            buildLogs: [
              {
                id: "log-1",
                buildId: "no-such-build",
                kind: "note",
                title: "Orphaned",
                createdAt: 1,
              },
            ],
            upgrades: [],
            assets: [],
            preferences: [],
          }),
        /build log log-1 references unknown build no-such-build/,
      );
    });

    it("rejects malformed build, asset, and preference records", () => {
      const base = {
        format: "jarvis-backup" as const,
        version: 3 as const,
        createdAt: "2026-07-13T03:30:00.000Z",
        state: {},
        tasks: [],
        reminders: [],
        buildLogs: [],
        upgrades: [],
      };
      assert.throws(
        () =>
          parseBackup({
            ...base,
            builds: [{ id: "b-1", name: "Trailer", kind: "shed", status: "unknown-status" }],
            assets: [],
            preferences: [],
          }),
        /invalid status/,
      );
      assert.throws(
        () =>
          parseBackup({
            ...base,
            builds: [],
            assets: [{ id: "a-1", name: "Grinder", kind: "tool", createdAt: "not-a-number" }],
            preferences: [],
          }),
        /invalid createdAt/,
      );
      assert.throws(
        () =>
          parseBackup({
            ...base,
            builds: [],
            assets: [],
            preferences: [
              { id: "p-1", key: "brand", value: "Dulux", createdAt: 1, updatedAt: 1 },
              { id: "p-1", key: "brand", value: "Dulux", createdAt: 1, updatedAt: 1 },
            ],
          }),
        /duplicate preference id/,
      );
    });

    it("round-trips through the real JSON-file stores end to end", async () => {
      const source = new JSONPersistence(path.join(tempDir, "source.json"));
      const sourceMemory: BackupMemoryStores = {
        builds: new JsonBuildStore(path.join(tempDir, "src-builds.json")),
        buildLogs: new JsonBuildLogStore(path.join(tempDir, "src-build-logs.json")),
        upgrades: new JsonUpgradeStore(path.join(tempDir, "src-upgrades.json")),
        assets: new JsonAssetStore(path.join(tempDir, "src-assets.json")),
        preferences: new JsonPreferenceStore(path.join(tempDir, "src-preferences.json")),
      };
      const build = await sourceMemory.builds.add({ name: "Trailer", kind: "shed" });
      await sourceMemory.buildLogs.add({ buildId: build.id, title: "Origin", kind: "origin" });

      const archive = await exportBackup(source, undefined, sourceMemory);

      const destination = new JSONPersistence(path.join(tempDir, "dst.json"));
      const destinationMemory: BackupMemoryStores = {
        builds: new JsonBuildStore(path.join(tempDir, "dst-builds.json")),
        buildLogs: new JsonBuildLogStore(path.join(tempDir, "dst-build-logs.json")),
        upgrades: new JsonUpgradeStore(path.join(tempDir, "dst-upgrades.json")),
        assets: new JsonAssetStore(path.join(tempDir, "dst-assets.json")),
        preferences: new JsonPreferenceStore(path.join(tempDir, "dst-preferences.json")),
      };
      await restoreBackupIntoEmptyProvider(destination, archive, destinationMemory);

      const restoredBuilds = await destinationMemory.builds.list();
      const restoredLogs = await destinationMemory.buildLogs.list();
      assert.equal(restoredBuilds[0]?.name, "Trailer");
      assert.equal(restoredLogs[0]?.buildId, restoredBuilds[0]?.id);
    });
  });
});
