import assert from "node:assert/strict";
import { describe, it } from "node:test";

import runCli, { type ReadlineAdapter } from "../src/cli.js";
import {
  ConvexPersistence,
  type AssistantState,
  type ConvexClientLike,
  type PersistenceProvider,
  type Reminder,
  type Task,
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

type Faults = {
  loadState?: Error;
  listTasksCall?: number;
  listTasksError?: Error;
  listReminders?: Error;
  addTask?: Error;
  saveState?: Error;
};

class FaultInjectingPersistence implements PersistenceProvider {
  state: AssistantState = {};
  tasks: Task[];
  reminders: Reminder[];
  loadStateCalls = 0;
  listTasksCalls = 0;
  listRemindersCalls = 0;
  addTaskCalls = 0;
  saveStateCalls = 0;

  constructor(
    private readonly faults: Faults = {},
    initial: { tasks?: Task[]; reminders?: Reminder[]; state?: AssistantState } = {},
  ) {
    this.tasks = (initial.tasks ?? []).map((task) => ({ ...task }));
    this.reminders = (initial.reminders ?? []).map((reminder) => ({ ...reminder }));
    this.state = { ...(initial.state ?? {}) };
  }

  async loadState(): Promise<AssistantState> {
    this.loadStateCalls += 1;
    if (this.faults.loadState) throw this.faults.loadState;
    return { ...this.state };
  }

  async saveState(state: AssistantState): Promise<void> {
    this.saveStateCalls += 1;
    if (this.faults.saveState) throw this.faults.saveState;
    this.state = { ...state };
  }

  async listTasks(): Promise<Task[]> {
    this.listTasksCalls += 1;
    if (this.faults.listTasksCall === this.listTasksCalls) {
      throw this.faults.listTasksError ?? new Error("task listing failed");
    }
    return this.tasks.map((task) => ({ ...task }));
  }

  async addTask(title: string, category: string): Promise<Task> {
    this.addTaskCalls += 1;
    if (this.faults.addTask) throw this.faults.addTask;
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
    this.listRemindersCalls += 1;
    if (this.faults.listReminders) throw this.faults.listReminders;
    return this.reminders.map((reminder) => ({ ...reminder }));
  }

  async addReminder(title: string, due?: string): Promise<Reminder> {
    const reminder: Reminder = {
      id: `reminder-${this.reminders.length + 1}`,
      title,
      ...(due === undefined ? {} : { due }),
      createdAt: Date.now(),
    };
    this.reminders.push(reminder);
    return { ...reminder };
  }

  async removeReminder(id: string): Promise<Reminder | null> {
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

function asConvexClient(client: {
  query(reference: unknown, args?: Record<string, unknown>): Promise<unknown>;
  mutation(reference: unknown, args: Record<string, unknown>): Promise<unknown>;
}): ConvexClientLike {
  return client as ConvexClientLike;
}

describe("failure behaviour matrix", () => {
  it("fails closed before the ready prompt when startup authentication fails", async () => {
    const persistence = new FaultInjectingPersistence({
      loadState: new Error("Unauthorized: invalid Jarvis service token."),
    });
    const readline = new ScriptedReadline(["task add must-not-run"]);
    const logs = capture();

    await assert.rejects(
      () => runCli({ persistence, readline, stdout: logs.stdout, stderr: logs.stderr }),
      /Unauthorized/,
    );

    assert.equal(readline.closed, true);
    assert.equal(readline.prompts.length, 0);
    assert.equal(persistence.addTaskCalls, 0);
    assert(logs.errors.some((line) => line.includes("Failed to load persistent data")));
    assert.equal(logs.output.some((line) => line.includes("Jarvis CLI ready")), false);
  });

  it("fails closed when any parallel startup read is offline", async () => {
    const persistence = new FaultInjectingPersistence({
      listTasksCall: 1,
      listTasksError: new TypeError("fetch failed: network offline"),
    });
    const readline = new ScriptedReadline(["exit"]);
    const logs = capture();

    await assert.rejects(
      () => runCli({ persistence, readline, stdout: logs.stdout, stderr: logs.stderr }),
      /network offline/,
    );

    assert.equal(readline.closed, true);
    assert.equal(readline.prompts.length, 0);
    assert.equal(persistence.loadStateCalls, 1);
    assert.equal(persistence.listTasksCalls, 1);
    assert.equal(persistence.listRemindersCalls, 1);
  });

  it("keeps the session alive after a transient offline list command", async () => {
    const persistence = new FaultInjectingPersistence({
      listTasksCall: 2,
      listTasksError: new TypeError("fetch failed: temporary outage"),
    });
    const readline = new ScriptedReadline(["task list", "task add Recovered", "exit"]);
    const logs = capture();

    await runCli({ persistence, readline, stdout: logs.stdout, stderr: logs.stderr });

    assert.equal(readline.closed, true);
    assert.equal(readline.prompts.length, 3);
    assert.equal(persistence.tasks.length, 1);
    assert.equal(persistence.tasks[0].title, "Recovered");
    assert(logs.errors.some((line) => line.includes("Command failed: fetch failed")));
    assert(logs.output.some((line) => line.includes("Task added: Recovered")));
  });

  it("does not mutate or save runtime state when an unauthorized write is rejected", async () => {
    const persistence = new FaultInjectingPersistence({
      addTask: new Error("Unauthorized: invalid Jarvis service token."),
    });
    const readline = new ScriptedReadline(["task add Blocked", "task list", "exit"]);
    const logs = capture();

    await runCli({ persistence, readline, stdout: logs.stdout, stderr: logs.stderr });

    assert.equal(persistence.tasks.length, 0);
    assert.equal(persistence.saveStateCalls, 0);
    assert(logs.errors.some((line) => line.includes("Command failed: Unauthorized")));
    assert(logs.output.some((line) => line.includes("No tasks saved")));
  });

  it("keeps a durable removal when the secondary runtime-state save fails", async () => {
    const persistence = new FaultInjectingPersistence(
      { saveState: new Error("state backend unavailable") },
      {
        tasks: [
          {
            id: "task-1",
            title: "Remove me",
            completed: false,
            category: "personal",
            createdAt: 1,
          },
        ],
      },
    );
    const readline = new ScriptedReadline(["task remove task-1", "task list", "exit"]);
    const logs = capture();

    await runCli({ persistence, readline, stdout: logs.stdout, stderr: logs.stderr });

    assert.deepEqual(persistence.tasks, []);
    assert.equal(persistence.saveStateCalls, 1);
    assert(logs.errors.some((line) => line.includes("Failed to save runtime state")));
    assert(logs.output.some((line) => line.includes("Task removed: Remove me")));
    assert(logs.output.some((line) => line.includes("No tasks saved")));
  });

  it("propagates offline and unauthorized Convex failures without fallback writes", async () => {
    let mutationCalls = 0;
    const offline = new TypeError("fetch failed: Convex offline");
    const unauthorized = new Error("Unauthorized: invalid Jarvis service token.");
    const provider = new ConvexPersistence(
      asConvexClient({
        async query() {
          throw offline;
        },
        async mutation() {
          mutationCalls += 1;
          throw unauthorized;
        },
      }),
      "configured-token",
    );

    await assert.rejects(() => provider.listTasks(), /Convex offline/);
    assert.equal(mutationCalls, 0);
    await assert.rejects(() => provider.addTask("Blocked", "personal"), /Unauthorized/);
    assert.equal(mutationCalls, 1);
  });
});
