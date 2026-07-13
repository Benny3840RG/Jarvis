import assert from "node:assert/strict";
import { describe, it } from "node:test";

import type {
  AssistantState,
  PersistenceProvider,
  Reminder,
  Task,
} from "../src/persistence/persistence.js";
import { redactSecret, runConvexSmoke } from "../src/tools/convexSmoke.js";

type SharedStore = {
  state: AssistantState;
  tasks: Task[];
  reminders: Reminder[];
  nextTask: number;
  nextReminder: number;
  failComplete: boolean;
};

class FakePersistence implements PersistenceProvider {
  constructor(private readonly store: SharedStore) {}

  async loadState(): Promise<AssistantState> {
    return { ...this.store.state };
  }

  async saveState(state: AssistantState): Promise<void> {
    this.store.state = { ...state };
  }

  async listTasks(): Promise<Task[]> {
    return this.store.tasks.map((task) => ({ ...task }));
  }

  async addTask(title: string, category: string): Promise<Task> {
    const task: Task = {
      id: `task-${++this.store.nextTask}`,
      title,
      completed: false,
      category,
      createdAt: this.store.nextTask,
    };
    this.store.tasks.push(task);
    return { ...task };
  }

  async completeTask(id: string): Promise<Task | null> {
    if (this.store.failComplete) throw new Error("forced completion failure");
    const task = this.store.tasks.find((entry) => entry.id === id);
    if (!task) return null;
    task.completed = true;
    return { ...task };
  }

  async removeTask(id: string): Promise<Task | null> {
    const index = this.store.tasks.findIndex((entry) => entry.id === id);
    if (index < 0) return null;
    const [task] = this.store.tasks.splice(index, 1);
    return { ...task };
  }

  async listReminders(): Promise<Reminder[]> {
    return this.store.reminders.map((reminder) => ({ ...reminder }));
  }

  async addReminder(title: string, due?: string): Promise<Reminder> {
    const reminder: Reminder = {
      id: `reminder-${++this.store.nextReminder}`,
      title,
      ...(due === undefined ? {} : { due }),
      createdAt: this.store.nextReminder,
    };
    this.store.reminders.push(reminder);
    return { ...reminder };
  }

  async removeReminder(id: string): Promise<Reminder | null> {
    const index = this.store.reminders.findIndex((entry) => entry.id === id);
    if (index < 0) return null;
    const [reminder] = this.store.reminders.splice(index, 1);
    return { ...reminder };
  }
}

function makeStore(overrides: Partial<SharedStore> = {}): SharedStore {
  return {
    state: {},
    tasks: [],
    reminders: [],
    nextTask: 0,
    nextReminder: 0,
    failComplete: false,
    ...overrides,
  };
}

describe("Convex smoke runner", () => {
  it("refuses non-development deployments before creating a provider", async () => {
    let factoryCalls = 0;
    await assert.rejects(
      () =>
        runConvexSmoke(
          () => {
            factoryCalls += 1;
            return new FakePersistence(makeStore());
          },
          "prod:jarvis",
          () => undefined,
        ),
      /development deployment/,
    );
    assert.equal(factoryCalls, 0);
  });

  it("verifies restart visibility and cleans up all created records", async () => {
    const store = makeStore();
    let factoryCalls = 0;
    const messages: string[] = [];

    const result = await runConvexSmoke(
      () => {
        factoryCalls += 1;
        return new FakePersistence(store);
      },
      "dev:test-deployment",
      (message) => messages.push(message),
    );

    assert.equal(result.taskCreated, true);
    assert.equal(result.taskCompleted, true);
    assert.equal(result.taskRemoved, true);
    assert.equal(result.reminderCreated, true);
    assert.equal(result.reminderRemoved, true);
    assert.equal(result.restartVisibilityVerified, true);
    assert(factoryCalls >= 4);
    assert.deepEqual(store.tasks, []);
    assert.deepEqual(store.reminders, []);
    assert(messages.some((message) => message.includes("Convex smoke passed")));
  });

  it("cleans up task and reminder records when verification fails", async () => {
    const store = makeStore({ failComplete: true });

    await assert.rejects(
      () =>
        runConvexSmoke(
          () => new FakePersistence(store),
          "dev:test-deployment",
          () => undefined,
        ),
      /forced completion failure/,
    );

    assert.deepEqual(store.tasks, []);
    assert.deepEqual(store.reminders, []);
  });

  it("redacts the configured service token from surfaced errors", () => {
    const secret = "super-secret-token";
    const redacted = redactSecret(new Error(`Request failed with ${secret}`), secret);
    assert.equal(redacted.includes(secret), false);
    assert(redacted.includes("[REDACTED]"));
  });
});
