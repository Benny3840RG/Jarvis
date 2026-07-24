import assert from "node:assert/strict";
import { describe, it } from "node:test";

import type {
  CompleteControlledTaskInput,
  ControlledTaskRecord,
  ControlledTaskStore,
  CreateControlledTaskInput,
} from "../src/tasks/controlledTask.js";

class DurableTaskStore implements ControlledTaskStore {
  private sequence = 0;
  private readonly tasks = new Map<string, ControlledTaskRecord>();
  private readonly creates = new Map<
    string,
    { fingerprint: string; result: ControlledTaskRecord }
  >();
  private readonly completions = new Map<
    string,
    { fingerprint: string; result: ControlledTaskRecord }
  >();

  async create(input: CreateControlledTaskInput): Promise<ControlledTaskRecord> {
    const key = `${input.projectId}:${input.idempotencyKey}`;
    const existing = this.creates.get(key);
    if (existing) {
      if (existing.fingerprint !== input.actionFingerprint) {
        throw new Error("Task create idempotency key belongs to another action fingerprint.");
      }
      return { ...existing.result };
    }

    const now = 100 + this.sequence;
    const task: ControlledTaskRecord = {
      id: `task-${++this.sequence}`,
      projectId: input.projectId,
      title: input.title,
      category: input.category,
      completed: false,
      createdAt: now,
      updatedAt: now,
      revision: 1,
    };
    this.tasks.set(task.id, task);
    this.creates.set(key, { fingerprint: input.actionFingerprint, result: task });
    return { ...task };
  }

  async complete(input: CompleteControlledTaskInput): Promise<ControlledTaskRecord | null> {
    const key = `${input.projectId}:${input.idempotencyKey}`;
    const existingResult = this.completions.get(key);
    if (existingResult) {
      if (existingResult.fingerprint !== input.actionFingerprint) {
        throw new Error("Task completion idempotency key belongs to another action fingerprint.");
      }
      return { ...existingResult.result };
    }

    const task = this.tasks.get(input.taskId);
    if (!task || task.projectId !== input.projectId) return null;
    if (task.completed) {
      throw new Error("Task is already completed without this controlled action receipt.");
    }
    const completed: ControlledTaskRecord = {
      ...task,
      completed: true,
      updatedAt: task.updatedAt + 1,
      revision: task.revision + 1,
      completedAt: task.updatedAt + 1,
    };
    this.tasks.set(task.id, completed);
    this.completions.set(key, { fingerprint: input.actionFingerprint, result: completed });
    return { ...completed };
  }

  async get(projectId: string, taskId: string): Promise<ControlledTaskRecord | null> {
    const task = this.tasks.get(taskId);
    return task?.projectId === projectId ? { ...task } : null;
  }

  async cleanup(projectId: string, taskId: string): Promise<boolean> {
    const task = this.tasks.get(taskId);
    if (!task || task.projectId !== projectId) return false;
    this.tasks.delete(taskId);
    return true;
  }
}

function createInput(
  overrides: Partial<CreateControlledTaskInput> = {},
): CreateControlledTaskInput {
  return {
    projectId: "project-1",
    title: "Service compressor",
    category: "workshop",
    idempotencyKey: "task-create-key",
    actionFingerprint: "jarvis-action-fingerprint:v1:create",
    sourceRequestId: "request-create",
    correlationId: "correlation-create",
    source: "test",
    ...overrides,
  };
}

describe("controlled task actions", () => {
  it("returns the exact create result for an idempotent replay", async () => {
    const store = new DurableTaskStore();
    const first = await store.create(createInput());
    const replay = await store.create(createInput());

    assert.deepEqual(replay, first);
    assert.equal(replay.id, "task-1");
  });

  it("rejects a create-key collision with a different fingerprint", async () => {
    const store = new DurableTaskStore();
    await store.create(createInput());
    await assert.rejects(
      store.create(
        createInput({
          title: "Different task",
          actionFingerprint: "jarvis-action-fingerprint:v1:different",
        }),
      ),
      /another action fingerprint/,
    );
    assert.equal((await store.get("project-1", "task-1"))?.title, "Service compressor");
  });

  it("completes once and replays the original completion snapshot", async () => {
    const store = new DurableTaskStore();
    const task = await store.create(createInput());
    const completion: CompleteControlledTaskInput = {
      projectId: "project-1",
      taskId: task.id,
      idempotencyKey: "task-complete-key",
      actionFingerprint: "jarvis-action-fingerprint:v1:complete",
      sourceRequestId: "request-complete",
      correlationId: "correlation-complete",
      source: "test",
    };

    const first = await store.complete(completion);
    const replay = await store.complete(completion);

    assert.equal(first?.completed, true);
    assert.equal(first?.revision, 2);
    assert.deepEqual(replay, first);
  });

  it("rejects stale completion and hides cross-project records", async () => {
    const store = new DurableTaskStore();
    const task = await store.create(createInput());
    const first = await store.complete({
      projectId: "project-1",
      taskId: task.id,
      idempotencyKey: "first-completion",
      actionFingerprint: "jarvis-action-fingerprint:v1:first-completion",
      sourceRequestId: "request-first-completion",
      correlationId: "correlation-first-completion",
      source: "test",
    });
    assert.equal(first?.completed, true);

    await assert.rejects(
      store.complete({
        projectId: "project-1",
        taskId: task.id,
        idempotencyKey: "second-completion",
        actionFingerprint: "jarvis-action-fingerprint:v1:second-completion",
        sourceRequestId: "request-second-completion",
        correlationId: "correlation-second-completion",
        source: "test",
      }),
      /already completed/,
    );
    assert.equal(await store.get("project-2", task.id), null);
  });
});
