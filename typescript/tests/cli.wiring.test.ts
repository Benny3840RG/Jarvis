import assert from "node:assert/strict";
import { describe, it } from "node:test";

import runCli, { type ReadlineAdapter } from "../src/cli.js";
import type {
  AssistantState,
  PersistenceProvider,
  Reminder,
  ReminderDue,
  ReminderUpdate,
  Task,
  TaskUpdate,
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

class CallbackReadline implements ReadlineAdapter {
  readonly prompts: string[] = [];
  closed = false;

  constructor(private readonly steps: Array<() => string>) {}

  async question(prompt: string): Promise<string> {
    this.prompts.push(prompt);
    return this.steps.shift()?.() ?? "exit";
  }

  close(): void {
    this.closed = true;
  }
}

class MockPersistence implements PersistenceProvider {
  loadCalled = 0;
  saveCalled = 0;
  listTasksCalled = 0;
  listRemindersCalled = 0;
  addTaskCalled = 0;
  updateTaskCalled = 0;
  addReminderCalled = 0;
  updateReminderCalled = 0;
  completeTaskCalled = 0;
  removeTaskCalled = 0;
  removeReminderCalled = 0;
  state: AssistantState;
  tasks: Task[];
  reminders: Reminder[];
  readonly events: string[] = [];
  failStateSave = false;

  constructor(
    initial: {
      state?: AssistantState;
      tasks?: Task[];
      reminders?: Reminder[];
    } = {},
  ) {
    this.state = { ...(initial.state ?? {}) };
    this.tasks = (initial.tasks ?? []).map((task) => ({ ...task }));
    this.reminders = (initial.reminders ?? []).map((reminder) => ({
      ...reminder,
    }));
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
    this.listTasksCalled += 1;
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

  async updateTask(id: string, update: TaskUpdate): Promise<Task | null> {
    this.events.push("task-update");
    this.updateTaskCalled += 1;
    if (update.title === undefined && update.category === undefined) {
      throw new Error("Task update requires --title or --category.");
    }
    const task = this.tasks.find((entry) => entry.id === id);
    if (!task) return null;
    if (update.title !== undefined) {
      const title = update.title.trim();
      if (title.length === 0) throw new Error("Task title cannot be empty.");
      task.title = title;
    }
    if (update.category !== undefined) {
      const category = update.category.trim();
      if (category.length === 0)
        throw new Error("Task category cannot be empty.");
      task.category = category;
    }
    return { ...task };
  }

  async completeTask(id: string): Promise<Task | null> {
    this.completeTaskCalled += 1;
    const task = this.tasks.find((entry) => entry.id === id);
    if (!task) return null;
    task.completed = true;
    return { ...task };
  }

  async removeTask(id: string): Promise<Task | null> {
    this.removeTaskCalled += 1;
    const index = this.tasks.findIndex((entry) => entry.id === id);
    if (index < 0) return null;
    const [task] = this.tasks.splice(index, 1);
    return { ...task };
  }

  async listReminders(): Promise<Reminder[]> {
    this.listRemindersCalled += 1;
    return this.reminders.map((reminder) => ({ ...reminder }));
  }

  async addReminder(title: string, due?: ReminderDue): Promise<Reminder> {
    this.events.push("reminder-write");
    this.addReminderCalled += 1;
    const reminder: Reminder = {
      id: `reminder-${this.reminders.length + 1}`,
      title,
      ...(due === undefined
        ? {}
        : {
            dueRaw: due.raw,
            ...(due.at === undefined
              ? {}
              : { dueAt: due.at, dueTimezone: due.timezone as string }),
          }),
      createdAt: this.reminders.length + 1,
    };
    this.reminders.push(reminder);
    return { ...reminder };
  }

  async updateReminder(
    id: string,
    update: ReminderUpdate,
  ): Promise<Reminder | null> {
    this.events.push("reminder-update");
    this.updateReminderCalled += 1;
    if (update.title === undefined && update.due === undefined) {
      throw new Error(
        "Reminder update requires --title, --due, or --clear-due.",
      );
    }
    const reminder = this.reminders.find((entry) => entry.id === id);
    if (!reminder) return null;
    if (update.title !== undefined) {
      const title = update.title.trim();
      if (title.length === 0)
        throw new Error("Reminder title cannot be empty.");
      reminder.title = title;
    }
    if (update.due === null) {
      delete reminder.dueRaw;
      delete reminder.dueAt;
      delete reminder.dueTimezone;
    } else if (update.due !== undefined) {
      reminder.dueRaw = update.due.raw;
      if (update.due.at === undefined) {
        delete reminder.dueAt;
        delete reminder.dueTimezone;
      } else {
        reminder.dueAt = update.due.at;
        reminder.dueTimezone = update.due.timezone as string;
      }
    }
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

    await runCli({
      persistence,
      readline,
      stdout: logs.stdout,
      stderr: logs.stderr,
    });

    assert.equal(persistence.loadCalled, 1);
    assert.equal(persistence.listTasksCalled, 1);
    assert.equal(persistence.listRemindersCalled, 1);
    assert.equal(persistence.saveCalled, 0);
    assert.deepEqual(readline.prompts, ["You: "]);
    assert.equal(readline.closed, true);
    assert(logs.output.some((line) => line.includes("Jarvis CLI ready")));
  });

  it("writes a task durably before saving runtime state", async () => {
    const persistence = new MockPersistence();
    const readline = new ScriptedReadline(["task add Call Claire", "exit"]);
    const logs = capture();

    await runCli({
      persistence,
      readline,
      stdout: logs.stdout,
      stderr: logs.stderr,
    });

    assert.deepEqual(persistence.events, ["task-write", "state-save"]);
    assert.equal(persistence.tasks[0].title, "Call Claire");
    assert(
      logs.output.some((line) => line.includes("Task added: Call Claire")),
    );
  });

  it("updates task and reminder fields using explicit flags", async () => {
    const persistence = new MockPersistence({
      tasks: [
        {
          id: "task-1",
          title: "Old task",
          completed: false,
          category: "personal",
          createdAt: 1,
        },
      ],
      reminders: [
        {
          id: "reminder-1",
          title: "Old reminder",
          dueRaw: "Monday",
          createdAt: 1,
        },
      ],
    });
    const logs = capture();

    await runCli({
      persistence,
      readline: new ScriptedReadline([
        "task update task-1 --category work --title Revised task",
        "reminder update reminder-1 --title Revised reminder --due Friday 9am",
        "reminder update reminder-1 --clear-due",
        "task list",
        "reminder list",
        "exit",
      ]),
      stdout: logs.stdout,
      stderr: logs.stderr,
    });

    assert.equal(persistence.updateTaskCalled, 1);
    assert.equal(persistence.tasks[0].title, "Revised task");
    assert.equal(persistence.tasks[0].category, "work");
    assert.equal(persistence.updateReminderCalled, 2);
    assert.equal(persistence.reminders[0].title, "Revised reminder");
    assert.equal(persistence.reminders[0].dueRaw, undefined);
    assert(
      logs.output.some((line) =>
        line.includes("Task updated: Revised task [work]"),
      ),
    );
    assert(
      logs.output.some((line) =>
        line.includes("Reminder updated: Revised reminder"),
      ),
    );
    assert(logs.output.some((line) => line.includes("Revised task [work]")));
  });

  it("rejects missing, duplicate, unknown, and conflicting update options without writing", async () => {
    const persistence = new MockPersistence({
      tasks: [
        {
          id: "task-1",
          title: "Untouched",
          completed: false,
          category: "personal",
          createdAt: 1,
        },
      ],
      reminders: [
        {
          id: "reminder-1",
          title: "Untouched reminder",
          dueRaw: "Monday",
          createdAt: 1,
        },
      ],
    });
    const logs = capture();

    await runCli({
      persistence,
      readline: new ScriptedReadline([
        "task update task-1",
        "task update task-1 --title One --title Two",
        "task update task-1 --bogus nope",
        "reminder update reminder-1 --due Friday 9am --clear-due",
        "exit",
      ]),
      stdout: logs.stdout,
      stderr: logs.stderr,
    });

    assert.equal(persistence.updateTaskCalled, 1);
    assert.equal(persistence.updateReminderCalled, 0);
    assert.equal(persistence.tasks[0].title, "Untouched");
    assert(logs.errors.some((line) => line.includes("Task update requires")));
    assert(
      logs.errors.some((line) => line.includes("Duplicate update option")),
    );
    assert(logs.errors.some((line) => line.includes("Unknown update option")));
    assert(
      logs.errors.some((line) =>
        line.includes("cannot use --due and --clear-due"),
      ),
    );
  });

  it("removes a task durably and refreshes the displayed list", async () => {
    const persistence = new MockPersistence({
      tasks: [
        {
          id: "task-1",
          title: "Temporary task",
          completed: false,
          category: "personal",
          createdAt: 1,
        },
      ],
    });
    const logs = capture();

    await runCli({
      persistence,
      readline: new ScriptedReadline([
        "task remove task-1",
        "task list",
        "exit",
      ]),
      stdout: logs.stdout,
      stderr: logs.stderr,
    });

    assert.equal(persistence.removeTaskCalled, 1);
    assert.deepEqual(persistence.tasks, []);
    assert(
      logs.output.some((line) => line.includes("Task removed: Temporary task")),
    );
    assert(logs.output.some((line) => line.includes("No tasks saved")));
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

  it("refreshes lists and summaries from durable storage during a running session", async () => {
    const persistence = new MockPersistence();
    const logs = capture();
    const readline = new CallbackReadline([
      () => {
        persistence.tasks.push({
          id: "external-task-1",
          title: "Added by another process",
          completed: false,
          category: "personal",
          createdAt: 1,
        });
        return "task list";
      },
      () => {
        persistence.tasks.push({
          id: "external-task-2",
          title: "Added before summary",
          completed: false,
          category: "personal",
          createdAt: 2,
        });
        return "summary";
      },
      () => {
        persistence.reminders.push({
          id: "external-reminder-1",
          title: "External reminder",
          dueRaw: "Monday",
          createdAt: 1,
        });
        return "reminder list";
      },
      () => "exit",
    ]);

    await runCli({
      persistence,
      readline,
      stdout: logs.stdout,
      stderr: logs.stderr,
    });

    assert.equal(persistence.listTasksCalled, 3);
    assert.equal(persistence.listRemindersCalled, 2);
    assert(
      logs.output.some((line) => line.includes("Added by another process")),
    );
    assert(logs.output.some((line) => line.includes("Added before summary")));
    assert(logs.output.some((line) => line.includes("External reminder")));
  });

  it("requires explicit reminder syntax and preserves raw due text", async () => {
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
    assert.equal(persistence.reminders[0].dueRaw, "Friday 9am");
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
    assert.equal(persistence.updateTaskCalled, 0);
    assert.equal(persistence.updateReminderCalled, 0);
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
        "task update garbage --title Missing",
        "task complete garbage",
        "task remove garbage",
        "reminder update garbage --title Missing",
        "reminder remove garbage",
        "task add Still running",
        "exit",
      ]),
      stdout: logs.stdout,
      stderr: logs.stderr,
    });

    assert.equal(persistence.updateTaskCalled, 1);
    assert.equal(persistence.completeTaskCalled, 1);
    assert.equal(persistence.removeTaskCalled, 1);
    assert.equal(persistence.updateReminderCalled, 1);
    assert.equal(persistence.removeReminderCalled, 1);
    assert.equal(persistence.addTaskCalled, 1);
    assert(
      logs.output.filter((line) => line.includes("Task not found")).length >= 3,
    );
    assert(
      logs.output.filter((line) => line.includes("Reminder not found"))
        .length >= 2,
    );
    assert(
      logs.output.some((line) => line.includes("Task added: Still running")),
    );
  });

  it("warns on runtime-state save failure without killing the session", async () => {
    const persistence = new MockPersistence();
    persistence.failStateSave = true;
    const logs = capture();
    await runCli({
      persistence,
      readline: new ScriptedReadline([
        "task add Durable task",
        "task list",
        "exit",
      ]),
      stdout: logs.stdout,
      stderr: logs.stderr,
    });

    assert.equal(persistence.tasks.length, 1);
    assert(
      logs.errors.some((line) => line.includes("Failed to save runtime state")),
    );
    assert(logs.output.some((line) => line.includes("Durable task")));
  });

  it("preserves planning behaviour when the phrase also contains task", async () => {
    const persistence = new MockPersistence();
    const logs = capture();
    await runCli({
      persistence,
      readline: new ScriptedReadline(["plan workshop task", "exit"]),
      stdout: logs.stdout,
      stderr: logs.stderr,
    });

    assert.equal(persistence.state.lastIntent, "planning");
    assert(logs.output.some((line) => line.includes("Workflow:")));
    assert.equal(
      logs.output.some((line) => line.includes("dueDate")),
      false,
    );
    assert.equal(
      logs.output.some((line) => line.includes("Use `task add")),
      false,
    );
  });
});
