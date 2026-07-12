import assert from "node:assert/strict";
import { describe, it } from "node:test";

import runCli, { type ReadlineAdapter } from "../src/cli.js";
import type { AssistantState, PersistenceProvider } from "../src/persistence/persistence.js";
import type { Reminder } from "../src/runtime/reminderService.js";
import type { Task } from "../src/runtime/taskService.js";

class ScriptedReadline implements ReadlineAdapter {
  readonly prompts: string[] = [];
  closed = false;

  constructor(private readonly inputs: string[]) {}

  async question(prompt: string): Promise<string> {
    this.prompts.push(prompt);
    return this.inputs.shift() ?? "exit";
  }

  close(): void {
    this.closed = true;
  }
}

class MockPersistence implements PersistenceProvider {
  loadCalled = 0;
  listTasksCalled = 0;
  listRemindersCalled = 0;
  saveCalled = 0;
  lastSaved: AssistantState | null = null;
  readonly events: string[] = [];
  private taskCounter = 0;
  private reminderCounter = 0;

  constructor(
    private readonly initial: AssistantState = {},
    private readonly tasks: Task[] = [],
    private readonly reminders: Reminder[] = [],
  ) {}

  async loadState(): Promise<AssistantState> {
    this.loadCalled += 1;
    return { ...this.initial };
  }

  async saveState(state: AssistantState): Promise<void> {
    this.events.push("save-state");
    this.saveCalled += 1;
    this.lastSaved = state;
  }

  async listTasks(): Promise<Task[]> {
    this.listTasksCalled += 1;
    return this.tasks.map((task) => ({ ...task }));
  }

  async addTask(title: string, category: string): Promise<Task> {
    this.events.push("add-task");
    const task = {
      id: `task-${++this.taskCounter}`,
      title,
      completed: false,
      category,
    };
    this.tasks.push(task);
    return { ...task };
  }

  async completeTask(id: string): Promise<Task | null> {
    this.events.push("complete-task");
    const task = this.tasks.find((entry) => entry.id === id);
    if (!task) return null;
    task.completed = true;
    return { ...task };
  }

  async listReminders(): Promise<Reminder[]> {
    this.listRemindersCalled += 1;
    return this.reminders.map((reminder) => ({ ...reminder }));
  }

  async addReminder(title: string, due?: string): Promise<Reminder> {
    this.events.push("add-reminder");
    const reminder = { id: `reminder-${++this.reminderCounter}`, title, due };
    this.reminders.push(reminder);
    return { ...reminder };
  }

  async removeReminder(id: string): Promise<boolean> {
    this.events.push("remove-reminder");
    const index = this.reminders.findIndex((entry) => entry.id === id);
    if (index < 0) return false;
    this.reminders.splice(index, 1);
    return true;
  }
}

function record(value: unknown): Record<string, unknown> {
  assert.equal(typeof value, "object");
  assert.notEqual(value, null);
  return value as Record<string, unknown>;
}

describe("interactive CLI durable persistence wiring", () => {
  it("loads state, tasks and reminders once before entering the loop", async () => {
    const persistence = new MockPersistence(
      { existing: "kept" },
      [{ id: "task-1", title: "Existing task", completed: false, category: "work" }],
      [{ id: "reminder-1", title: "Existing reminder", due: "today" }],
    );
    const readline = new ScriptedReadline(["exit"]);
    const output: string[] = [];

    await runCli({
      persistence,
      readline,
      stdout: (...values) => output.push(values.join(" ")),
    });

    assert.equal(persistence.loadCalled, 1);
    assert.equal(persistence.listTasksCalled, 1);
    assert.equal(persistence.listRemindersCalled, 1);
    assert.equal(persistence.saveCalled, 0);
    assert.deepEqual(readline.prompts, ["You: "]);
    assert.equal(readline.closed, true);
    assert(output.some((line) => line.includes("Jarvis CLI ready")));
  });

  it("persists reminders before printing success", async () => {
    const persistence = new MockPersistence();
    const readline = new ScriptedReadline(["remind me to buy milk", "exit"]);
    const output: string[] = [];

    await runCli({
      persistence,
      readline,
      stdout: (...values) => output.push(values.join(" ")),
    });

    assert.deepEqual(persistence.events, ["add-reminder", "save-state"]);
    const reminder = record(persistence.lastSaved?.lastReminder);
    assert.equal(reminder.title, "remind me to buy milk");
    assert.equal(reminder.due, "tomorrow");
    assert(output.some((line) => line.includes("Reminder set:")));
  });

  it("restores tasks on a later CLI run and summarizes them", async () => {
    const persistence = new MockPersistence();

    await runCli({
      persistence,
      readline: new ScriptedReadline(["task add Replace trailer floor", "exit"]),
      stdout: () => undefined,
    });

    const output: string[] = [];
    await runCli({
      persistence,
      readline: new ScriptedReadline(["summary", "task list", "exit"]),
      stdout: (...values) => output.push(values.join(" ")),
    });

    assert(output.some((line) => line.includes("1 pending task")));
    assert(output.some((line) => line.includes("Replace trailer floor")));
  });

  it("completes a durable task by id", async () => {
    const persistence = new MockPersistence(
      {},
      [{ id: "task-42", title: "Send invoice", completed: false, category: "business" }],
    );
    const output: string[] = [];

    await runCli({
      persistence,
      readline: new ScriptedReadline(["task complete task-42", "summary", "exit"]),
      stdout: (...values) => output.push(values.join(" ")),
    });

    assert.deepEqual(persistence.events, ["complete-task", "save-state"]);
    assert.equal(record(persistence.lastSaved?.lastTask).completed, true);
    assert(output.some((line) => line.includes("Task completed: Send invoice")));
    assert(output.some((line) => line.includes("no pending tasks")));
  });

  it("lists and removes durable reminders", async () => {
    const persistence = new MockPersistence(
      {},
      [],
      [{ id: "reminder-7", title: "Call Claire", due: "tomorrow" }],
    );
    const output: string[] = [];

    await runCli({
      persistence,
      readline: new ScriptedReadline([
        "reminder list",
        "reminder remove reminder-7",
        "reminder list",
        "exit",
      ]),
      stdout: (...values) => output.push(values.join(" ")),
    });

    assert(output.some((line) => line.includes("Call Claire")));
    assert(output.some((line) => line.includes("Reminder removed: reminder-7")));
    assert(output.some((line) => line.includes("No reminders saved")));
  });

  it("preserves planning behaviour", async () => {
    const persistence = new MockPersistence();
    const readline = new ScriptedReadline(["plan workshop task", "exit"]);
    const output: string[] = [];

    await runCli({
      persistence,
      readline,
      stdout: (...values) => output.push(values.join(" ")),
    });

    assert.equal(persistence.saveCalled, 1);
    assert.equal(persistence.lastSaved?.lastIntent, "planning");
    assert(output.some((line) => line.includes("Workflow:")));
  });

  it("restores prior state and persists general conversation fields", async () => {
    const persistence = new MockPersistence({ retained: "yes" });
    const readline = new ScriptedReadline(["hello Jarvis", "exit"]);

    await runCli({ persistence, readline, stdout: () => undefined });

    assert.equal(persistence.lastSaved?.retained, "yes");
    assert.equal(persistence.lastSaved?.lastInput, "hello Jarvis");
    assert.equal(persistence.lastSaved?.lastIntent, "greeting");
    assert.notEqual(persistence.lastSaved?.lastResult, undefined);
  });

  it("surfaces save failures and does not print false success", async () => {
    const base = new MockPersistence();
    const persistence: PersistenceProvider = {
      loadState: () => base.loadState(),
      listTasks: () => base.listTasks(),
      listReminders: () => base.listReminders(),
      addTask: (title, category) => base.addTask(title, category),
      completeTask: (id) => base.completeTask(id),
      addReminder: (title, due) => base.addReminder(title, due),
      removeReminder: (id) => base.removeReminder(id),
      async saveState() {
        throw new Error("disk full");
      },
    };
    const readline = new ScriptedReadline(["remind me to buy milk", "exit"]);
    const output: string[] = [];
    const errors: string[] = [];

    await assert.rejects(
      runCli({
        persistence,
        readline,
        stdout: (...values) => output.push(values.join(" ")),
        stderr: (...values) => errors.push(values.join(" ")),
      }),
      /disk full/,
    );

    assert(errors.some((line) => line.includes("Failed to save persistent state")));
    assert.equal(output.some((line) => line.includes("Reminder set:")), false);
    assert.equal(readline.closed, true);
  });
});
