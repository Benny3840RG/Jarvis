import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, it } from "node:test";

import {
  exportBackup,
  parseBackup,
  readBackupFile,
  restoreBackupIntoEmptyProvider,
  verifyBackupRestore,
  writeBackupFile,
} from "../src/backup/backup.js";
import {
  JSONPersistence,
  type AssistantState,
  type PersistenceProvider,
  type Reminder,
  type Task,
} from "../src/persistence/persistence.js";

let tempDir = "";

beforeEach(async () => {
  tempDir = await fs.mkdtemp(path.join(os.tmpdir(), "jarvis-backup-test-"));
});

afterEach(async () => {
  await fs.rm(tempDir, { recursive: true, force: true });
});

class FailingRestoreProvider implements PersistenceProvider {
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

  async addReminder(): Promise<Reminder> {
    throw new Error("forced reminder restore failure");
  }

  async removeReminder(id: string): Promise<Reminder | null> {
    const index = this.reminders.findIndex((entry) => entry.id === id);
    if (index < 0) return null;
    const [reminder] = this.reminders.splice(index, 1);
    return { ...reminder };
  }
}

describe("Jarvis backup archives", () => {
  it("exports, writes, verifies, restores, and remaps state record IDs", async () => {
    const source = new JSONPersistence(path.join(tempDir, "source.json"));
    const pending = await source.addTask("Measure gate", "work");
    const completed = await source.addTask("Send invoice", "business");
    await source.completeTask(completed.id);
    const reminder = await source.addReminder("Call Claire", "Friday 9am");
    await source.saveState({
      lastTask: completed,
      lastReminder: reminder,
      nested: { ids: [pending.id, completed.id, reminder.id] },
    });

    const archive = await exportBackup(source, () => new Date("2026-07-13T03:30:00.000Z"));
    assert.equal(archive.createdAt, "2026-07-13T03:30:00.000Z");
    assert.equal(archive.tasks.length, 2);
    assert.equal(archive.reminders.length, 1);

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
    assert.equal(restoredReminders[0].due, "Friday 9am");
    assert.equal(
      (restoredState.lastTask as { id: string }).id,
      result.taskIds.get(completed.id),
    );
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

  it("refuses to overwrite an existing backup file", async () => {
    const provider = new JSONPersistence(path.join(tempDir, "source.json"));
    const archive = await exportBackup(provider);
    const backupPath = path.join(tempDir, "backup.json");
    await writeBackupFile(backupPath, archive);
    await assert.rejects(() => writeBackupFile(backupPath, archive), /already exists/);
  });

  it("refuses restore when the target contains state or records", async () => {
    const source = new JSONPersistence(path.join(tempDir, "source.json"));
    await source.addTask("Source task", "work");
    const archive = await exportBackup(source);

    const destination = new JSONPersistence(path.join(tempDir, "destination.json"));
    await destination.saveState({ occupied: true });
    await assert.rejects(
      () => restoreBackupIntoEmptyProvider(destination, archive),
      /target provider is not empty/,
    );
    assert.deepEqual(await destination.loadState(), { occupied: true });
  });

  it("rolls back records created before a restore failure", async () => {
    const archive = parseBackup({
      format: "jarvis-backup",
      version: 1,
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
      reminders: [
        {
          id: "source-reminder",
          title: "Failure trigger",
          createdAt: 2,
        },
      ],
    });
    const provider = new FailingRestoreProvider();

    await assert.rejects(
      () => restoreBackupIntoEmptyProvider(provider, archive),
      /forced reminder restore failure/,
    );
    assert.deepEqual(provider.tasks, []);
    assert.deepEqual(provider.reminders, []);
    assert.deepEqual(provider.state, {});
  });

  it("rejects unsupported versions and duplicate record IDs", () => {
    assert.throws(
      () =>
        parseBackup({
          format: "jarvis-backup",
          version: 2,
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
          version: 1,
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
});
