import assert from "node:assert/strict";
import { describe, it } from "node:test";

import type {
  CancelControlledReminderInput,
  ControlledReminderRecord,
  ControlledReminderStore,
  CreateControlledReminderInput,
} from "../src/reminders/controlledReminder.js";
import type {
  CompleteControlledTaskInput,
  ControlledTaskRecord,
  ControlledTaskStore,
  CreateControlledTaskInput,
} from "../src/tasks/controlledTask.js";
import { runTaskReminderActionsSmoke } from "../src/tools/taskReminderActionsSmoke.js";

type SharedState = {
  taskSequence: number;
  reminderSequence: number;
  tasks: Map<string, ControlledTaskRecord>;
  reminders: Map<string, ControlledReminderRecord>;
  taskCreateResults: Map<string, ControlledTaskRecord>;
  taskCompleteResults: Map<string, ControlledTaskRecord>;
  reminderCreateResults: Map<string, ControlledReminderRecord>;
  reminderCancelResults: Map<string, ControlledReminderRecord>;
  failTaskCompletion: boolean;
};

function sharedState(): SharedState {
  return {
    taskSequence: 0,
    reminderSequence: 0,
    tasks: new Map(),
    reminders: new Map(),
    taskCreateResults: new Map(),
    taskCompleteResults: new Map(),
    reminderCreateResults: new Map(),
    reminderCancelResults: new Map(),
    failTaskCompletion: false,
  };
}

function resultKey(input: { projectId: string; idempotencyKey: string }): string {
  return `${input.projectId}:${input.idempotencyKey}`;
}

class MemoryTaskStore implements ControlledTaskStore {
  constructor(private readonly state: SharedState) {}

  async create(input: CreateControlledTaskInput): Promise<ControlledTaskRecord> {
    const key = resultKey(input);
    const replay = this.state.taskCreateResults.get(key);
    if (replay) return { ...replay };
    const now = 1_785_000_000_000 + this.state.taskSequence;
    const record: ControlledTaskRecord = {
      id: `task-${++this.state.taskSequence}`,
      projectId: input.projectId,
      title: input.title,
      category: input.category,
      completed: false,
      createdAt: now,
      updatedAt: now,
      revision: 1,
    };
    this.state.tasks.set(record.id, record);
    this.state.taskCreateResults.set(key, record);
    return { ...record };
  }

  async complete(input: CompleteControlledTaskInput): Promise<ControlledTaskRecord | null> {
    if (this.state.failTaskCompletion) throw new Error("injected task completion failure");
    const key = resultKey(input);
    const replay = this.state.taskCompleteResults.get(key);
    if (replay) return { ...replay };
    const existing = this.state.tasks.get(input.taskId);
    if (!existing || existing.projectId !== input.projectId) return null;
    const completed: ControlledTaskRecord = {
      ...existing,
      completed: true,
      updatedAt: existing.updatedAt + 1,
      revision: existing.revision + 1,
      completedAt: existing.updatedAt + 1,
    };
    this.state.tasks.set(existing.id, completed);
    this.state.taskCompleteResults.set(key, completed);
    return { ...completed };
  }

  async get(projectId: string, taskId: string): Promise<ControlledTaskRecord | null> {
    const record = this.state.tasks.get(taskId);
    return record?.projectId === projectId ? { ...record } : null;
  }

  async cleanup(projectId: string, taskId: string): Promise<boolean> {
    const record = this.state.tasks.get(taskId);
    const removed = record?.projectId === projectId;
    if (removed) this.state.tasks.delete(taskId);
    for (const [key, value] of this.state.taskCreateResults) {
      if (value.projectId === projectId && value.id === taskId) this.state.taskCreateResults.delete(key);
    }
    for (const [key, value] of this.state.taskCompleteResults) {
      if (value.projectId === projectId && value.id === taskId) {
        this.state.taskCompleteResults.delete(key);
      }
    }
    return removed || !this.state.taskCreateResults.size || !this.state.taskCompleteResults.size;
  }
}

class MemoryReminderStore implements ControlledReminderStore {
  constructor(private readonly state: SharedState) {}

  async create(input: CreateControlledReminderInput): Promise<ControlledReminderRecord> {
    const key = resultKey(input);
    const replay = this.state.reminderCreateResults.get(key);
    if (replay) return { ...replay };
    const now = 1_785_100_000_000 + this.state.reminderSequence;
    const record: ControlledReminderRecord = {
      id: `reminder-${++this.state.reminderSequence}`,
      projectId: input.projectId,
      title: input.title,
      ...(input.dueRaw === undefined ? {} : { dueRaw: input.dueRaw }),
      ...(input.dueAt === undefined ? {} : { dueAt: input.dueAt }),
      ...(input.dueTimezone === undefined ? {} : { dueTimezone: input.dueTimezone }),
      createdAt: now,
      updatedAt: now,
      revision: 1,
    };
    this.state.reminders.set(record.id, record);
    this.state.reminderCreateResults.set(key, record);
    return { ...record };
  }

  async cancel(input: CancelControlledReminderInput): Promise<ControlledReminderRecord | null> {
    const key = resultKey(input);
    const replay = this.state.reminderCancelResults.get(key);
    if (replay) return { ...replay };
    const existing = this.state.reminders.get(input.reminderId);
    if (!existing || existing.projectId !== input.projectId) return null;
    const cancelled: ControlledReminderRecord = {
      ...existing,
      updatedAt: existing.updatedAt + 1,
      revision: existing.revision + 1,
      cancelledAt: existing.updatedAt + 1,
    };
    this.state.reminderCancelResults.set(key, cancelled);
    this.state.reminders.delete(existing.id);
    return { ...cancelled };
  }

  async get(projectId: string, reminderId: string): Promise<ControlledReminderRecord | null> {
    const record = this.state.reminders.get(reminderId);
    return record?.projectId === projectId ? { ...record } : null;
  }

  async cleanup(projectId: string, reminderId: string): Promise<boolean> {
    const record = this.state.reminders.get(reminderId);
    const removed = record?.projectId === projectId;
    if (removed) this.state.reminders.delete(reminderId);
    let removedResult = false;
    for (const [key, value] of this.state.reminderCreateResults) {
      if (value.projectId === projectId && value.id === reminderId) {
        this.state.reminderCreateResults.delete(key);
        removedResult = true;
      }
    }
    for (const [key, value] of this.state.reminderCancelResults) {
      if (value.projectId === projectId && value.id === reminderId) {
        this.state.reminderCancelResults.delete(key);
        removedResult = true;
      }
    }
    return removed || removedResult;
  }
}

function assertClean(state: SharedState): void {
  assert.equal(state.tasks.size, 0);
  assert.equal(state.reminders.size, 0);
  assert.equal(state.taskCreateResults.size, 0);
  assert.equal(state.taskCompleteResults.size, 0);
  assert.equal(state.reminderCreateResults.size, 0);
  assert.equal(state.reminderCancelResults.size, 0);
}

describe("task and reminder development smoke", () => {
  it("proves fresh-instance replay, state transitions and complete cleanup", async () => {
    const state = sharedState();
    const messages: string[] = [];
    const result = await runTaskReminderActionsSmoke(
      () => new MemoryTaskStore(state),
      () => new MemoryReminderStore(state),
      "dev:outgoing-ram-798",
      (message) => messages.push(message),
    );

    assert.deepEqual(result, {
      taskCreated: true,
      taskReplayed: true,
      taskRestartVisible: true,
      taskCompleted: true,
      taskCompletionReplayed: true,
      reminderCreated: true,
      reminderReplayed: true,
      reminderRestartVisible: true,
      reminderCancelled: true,
      reminderCancellationReplayed: true,
      cleaned: true,
    });
    assert.equal(messages.length, 1);
    assertClean(state);
  });

  it("refuses non-development targets before constructing a store", async () => {
    let constructions = 0;
    await assert.rejects(
      runTaskReminderActionsSmoke(
        () => {
          constructions += 1;
          return new MemoryTaskStore(sharedState());
        },
        () => {
          constructions += 1;
          return new MemoryReminderStore(sharedState());
        },
        "prod:jarvis",
      ),
      /must identify a development deployment/,
    );
    assert.equal(constructions, 0);
  });

  it("cleans the task and retained results after a mid-run failure", async () => {
    const state = sharedState();
    state.failTaskCompletion = true;
    await assert.rejects(
      runTaskReminderActionsSmoke(
        () => new MemoryTaskStore(state),
        () => new MemoryReminderStore(state),
        "dev:outgoing-ram-798",
      ),
      /injected task completion failure/,
    );
    assertClean(state);
  });
});
