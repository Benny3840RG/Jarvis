import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, it } from "node:test";

import { JSONPersistence } from "../src/persistence/persistence.js";

// Mirrors convex/controlledMutationBoundary.test.ts so the JSON provider enforces
// the same direct-mutation policy for project-scoped records as Convex.

let tempDir: string;
let provider: JSONPersistence;

beforeEach(async () => {
  tempDir = await fs.mkdtemp(path.join(os.tmpdir(), "jarvis-json-boundary-"));
  provider = new JSONPersistence(path.join(tempDir, "state.json"));
  await provider.restoreSnapshotIntoEmpty({
    state: { taskId: "project-task", reminderId: "project-reminder" },
    tasks: [
      {
        id: "project-task",
        projectId: "project-1",
        title: "Controlled task",
        completed: false,
        category: "workshop",
        createdAt: 1,
        updatedAt: 1,
        revision: 1,
      },
      {
        id: "personal-task",
        title: "Personal task",
        completed: false,
        category: "home",
        createdAt: 2,
      },
    ],
    reminders: [
      {
        id: "project-reminder",
        projectId: "project-1",
        title: "Controlled reminder",
        createdAt: 1,
        updatedAt: 1,
        revision: 1,
      },
      { id: "personal-reminder", title: "Personal reminder", createdAt: 2 },
    ],
  });
});

afterEach(async () => {
  await fs.rm(tempDir, { recursive: true, force: true });
});

async function idOf(title: string): Promise<string> {
  const task = (await provider.listTasks()).find((entry) => entry.title === title);
  assert.ok(task, `task ${title} should exist after restore`);
  return task.id;
}

async function reminderIdOf(title: string): Promise<string> {
  const reminder = (await provider.listReminders()).find((entry) => entry.title === title);
  assert.ok(reminder, `reminder ${title} should exist after restore`);
  return reminder.id;
}

describe("JSON controlled record mutation boundary", () => {
  it("keeps projectId on restored project-scoped records", async () => {
    const task = (await provider.listTasks()).find((entry) => entry.title === "Controlled task");
    const reminder = (await provider.listReminders()).find(
      (entry) => entry.title === "Controlled reminder",
    );
    assert.equal(task?.projectId, "project-1");
    assert.equal(reminder?.projectId, "project-1");
  });

  it("rejects direct updates to project-scoped tasks", async () => {
    const id = await idOf("Controlled task");
    await assert.rejects(
      provider.updateTask(id, { title: "Bypassed update" }),
      /controlled task execution/i,
    );
    assert.equal((await provider.listTasks()).find((t) => t.id === id)?.title, "Controlled task");
  });

  it("rejects direct completion of project-scoped tasks", async () => {
    const id = await idOf("Controlled task");
    await assert.rejects(provider.completeTask(id), /controlled task execution/i);
    assert.equal((await provider.listTasks()).find((t) => t.id === id)?.completed, false);
  });

  it("rejects direct removal of project-scoped tasks", async () => {
    const id = await idOf("Controlled task");
    await assert.rejects(provider.removeTask(id), /controlled task execution/i);
    assert.ok((await provider.listTasks()).some((t) => t.id === id));
  });

  it("rejects direct updates to project-scoped reminders", async () => {
    const id = await reminderIdOf("Controlled reminder");
    await assert.rejects(
      provider.updateReminder(id, { title: "Bypassed update" }),
      /controlled reminder execution/i,
    );
    const reminder = (await provider.listReminders()).find((r) => r.id === id);
    assert.equal(reminder?.title, "Controlled reminder");
    assert.equal(reminder?.projectId, "project-1");
  });

  it("rejects direct removal of project-scoped reminders", async () => {
    const id = await reminderIdOf("Controlled reminder");
    await assert.rejects(provider.removeReminder(id), /controlled reminder execution/i);
    assert.ok((await provider.listReminders()).some((r) => r.id === id));
  });

  it("still allows direct mutation of personal tasks and reminders", async () => {
    const taskId = await idOf("Personal task");
    assert.equal((await provider.updateTask(taskId, { title: "Renamed" }))?.title, "Renamed");
    assert.equal((await provider.completeTask(taskId))?.completed, true);
    assert.equal((await provider.removeTask(taskId))?.id, taskId);

    const reminderId = await reminderIdOf("Personal reminder");
    assert.equal(
      (await provider.updateReminder(reminderId, { title: "Renamed reminder" }))?.title,
      "Renamed reminder",
    );
    assert.equal((await provider.removeReminder(reminderId))?.id, reminderId);
  });
});
