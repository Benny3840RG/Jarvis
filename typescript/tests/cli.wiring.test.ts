import assert from "node:assert/strict";
import { describe, it } from "node:test";

import runCli, { type ReadlineAdapter } from "../src/cli.js";
import type {
  AssistantState,
  PersistenceProvider,
  Reminder,
  Task,
} from "../src/persistence/persistence.js";

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
  saveCalled = 0;
  addTaskCalled = 0;
  addReminderCalled = 0;
  completeTaskCalled = 0;
  removeReminderCalled = 0;
  state: AssistantState;
  tasks: Task[];
  reminders: Reminder[];
  readonly events: string[] = [];
  failStateSave = false;

  constructor(initial: {
    state?: AssistantState;
    tasks?: Task[];
    reminders?: Reminder[];
  } = {}) {
    this.state = { ...(initial.state ?? {}) };
    this.tasks = (initial.tasks ?? []).map((task) => ({ ...task }));
    this.reminders = (initial.reminders ?? []).map((reminder) => ({ ...reminder }));
  }

  async loadState(): Promise<AssistantState> {
    this.loadCalled += 1;
    return { ...this.state };
  }

  async saveState(state: AssistantState): Promise<void> {
    this.events.push("state-save");
    this.saveCalled += 1;
    if (this.failStateSave) throw new Error("disk full");
    this.state = { ...state };
  }

  async listTasks(): Promise<Task[]> {
    return this.tasks.map((task) => ({ ...task }));
  }

  async addTask(title: string, category: string): Promise<Task> {
    this.events.push("task-write");
    this.addTaskCalled += 1;
    const task = {
      id: `task-${this.tasks.length + 1}`,
      title,
      completed: false,
      category,
      createdAt: this.tasks.length + 1,
    };
    this.tasks.push(task);
    return { ...task };
  }

  async completeTask(id: string): Promise<Task | null> {
    this.completeTaskCalled += 1;
    const task = this.tasks.find((entry) => entry.id === id);
    if (!task) return null;
    task.completed = true;
    return { ...task };
  }

  async listReminders(): Promise<Reminder[]> {
    return this.reminders.map((reminder) => ({ ...reminder }));
  }

  async addReminder(title: string, due?: string): Promise<Reminder> {
    this.events.push("reminder-write");
    this.addReminderCalled += 1;
    const reminder = {
      id: `reminder-${this.reminders.length + 1}`,
      title,
      ...(due === undefined ? {} : { due }),
      createdAt: this.reminders.length + 1,
    };
    this.reminders.push(reminder);
    return { ...reminder };
  }

  async removeReminder(id: string): Promise<Reminder | null> {
    this.removeReminderCalled += 1;
    const index = this.reminders.findIndex((entry) => entry.id === id);
    if (index < 0) return null;
    const [reminder] = this.reminders.splice(index, 1);
    return { ...reminder };
  }
}

function capture() {
  const output: string[] = [];
  const errors: string[] = [];
  return {
    output,
    errors,
    stdout: (...values: unknown[]) => output.push(values.join(" ")),
    stderr: (...values: unknown[]) => errors.push(values.join(" ")),
  };
}

describe("interactive CLI persistence wiring", () => {
  it("loads state, tasks, and reminders once and exits through readline", async () => {
    const persistence = new MockPersistence({ state: { existing: "kept" } });
    const readline = new ScriptedReadline(["exit"]);
    const logs = capture();

    await runCli({ persistence, readline, stdout: logs.stdout, stderr: logs.stderr });

    assert.equal(persistence.loadCalled, 1);
    assert.equal(persistence.saveCalled, 0);
    assert.deepEqual(readline.prompts, ["You: "]);
    assert.equal(readline.closed, true);
    assert(logs.output.some((line) => line.includes("Jarvis CLI ready")));
  });

  it("writes a task durably before saving runtime state", async () => {
    const persistence = new MockPersistence();
    const readline = new ScriptedReadline(["task add Call Claire", "exit"]);
    const logs = capture();

    await runCli({ persistence, readline, stdout: logs.stdout, stderr: logs.stderr });

    assert.deepEqual(persistence.events, ["task-write", "state-save"]);
    assert.equal(persistence.tasks[0].title, "Call Claire");
    assert(logs.output.some((line) => line.includes("Task added: Call Claire")));
  });

  it("restores tasks on a later CLI run", async () => {
    const persistence = new MockPersistence();
    await runCli({
      persistence,
      readline: new ScriptedReadline(["task add Measure gate", "exit"]),
      stdout: () => undefined,
      stderr: () => undefined,
    });

    const logs = capture();
    await runCli({
      persistence,
      readline: new ScriptedReadline(["task list", "exit"]),
      stdout: logs.stdout,
      stderr: logs.stderr,
    });

    assert(logs.output.some((line) => line.includes("Measure gate")));
    assert.equal(persistence.loadCalled, 2);
  });

  it("requires explicit reminder syntax with a due value", async () => {
    const persistence = new MockPersistence();
    const logs = capture();
    await runCli({
      persistence,
      readline: new ScriptedReadline([
        "reminder add Call Claire",
        "reminder add Call Claire --due Friday 9am",
        "exit",
      ]),
      stdout: logs.stdout,
      stderr: logs.stderr,
    });

    assert.equal(persistence.addReminderCalled, 1);
    assert.equal(persistence.reminders[0].title, "Call Claire");
    assert.equal(persistence.reminders[0].due, "Friday 9am");
    assert(logs.output.some((line) => line.includes("Use `reminder add")));
  });

  it("never writes from fuzzy task or reminder phrases", async () => {
    const persistence = new MockPersistence();
    const logs = capture();
    await runCli({
      persistence,
      readline: new ScriptedReadline([
        "show my task list",
        "what tasks are left",
        "any tasks today",
        "any reminders today",
        "remind me to buy milk",
        "exit",
      ]),
      stdout: logs.stdout,
      stderr: logs.stderr,
    });

    assert.equal(persistence.addTaskCalled, 0);
    assert.equal(persistence.addReminderCalled, 0);
    assert.equal(persistence.saveCalled, 0);
    assert(logs.output.some((line) => line.includes("Use `task add")));
    assert(logs.output.some((line) => line.includes("Use `reminder add")));
  });

  it("keeps the REPL alive after malformed or nonexistent IDs", async () => {
    const persistence = new MockPersistence();
    const logs = capture();
    await runCli({
      persistence,
      readline: new ScriptedReadline([
        "task complete garbage",
        "reminder remove garbage",
        "task add Still running",
        "exit",
      ]),
      stdout: logs.stdout,
      stderr: logs.stderr,
    });

    assert.equal(persistence.completeTaskCalled, 1);
    assert.equal(persistence.removeReminderCalled, 1);
    assert.equal(persistence.addTaskCalled, 1);
    assert(logs.output.some((line) => line.includes("Task not found")));
    assert(logs.output.some((line) => line.includes("Reminder not found")));
    assert(logs.output.some((line) => line.includes("Task added: Still running")));
  });

  it("warns on runtime-state save failure without killing the session", async () => {
    const persistence = new MockPersistence();
    persistence.failStateSave = true;
    const logs = capture();
    await runCli({
      persistence,
      readline: new ScriptedReadline(["task add Durable task", "task list", "exit"]),
      stdout: logs.stdout,
      stderr: logs.stderr,
    });

    assert.equal(persistence.tasks.length, 1);
    assert(logs.errors.some((line) => line.includes("Failed to save runtime state")));
    assert(logs.output.some((line) => line.includes("Durable task")));
  });

  it("preserves planning behaviour", async () => {
    const persistence = new MockPersistence();
    const logs = capture();
    await runCli({
      persistence,
      readline: new ScriptedReadline(["plan workshop", "exit"]),
      stdout: logs.stdout,
      stderr: logs.stderr,
    });

    assert.equal(persistence.state.lastIntent, "planning");
    assert(logs.output.some((line) => line.includes("Workflow:")));
  });
});
