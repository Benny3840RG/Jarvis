import assert from "node:assert/strict";
import { describe, it } from "node:test";

import { ConvexControlledTaskStore } from "../src/persistence/convexControlledTasks.js";
import type { ConvexClientLike } from "../src/persistence/convexPersistence.js";

function taskRow(overrides: Partial<Record<string, unknown>> = {}) {
  return {
    kind: "task",
    id: "task-1",
    projectId: "project-1",
    title: "Service compressor",
    category: "workshop",
    completed: false,
    createdAt: 1,
    updatedAt: 1,
    revision: 1,
    ...overrides,
  };
}

describe("ConvexControlledTaskStore", () => {
  it("creates a controlled task through the authenticated mutation", async () => {
    const calls: unknown[] = [];
    const client = {
      async query() {
        throw new Error("query must not be called");
      },
      async mutation(_ref: unknown, args: unknown) {
        calls.push(args);
        return taskRow();
      },
    } as unknown as ConvexClientLike;
    const store = new ConvexControlledTaskStore(client, "owner-service-token");

    const result = await store.create({
      projectId: "project-1",
      title: "Service compressor",
      category: "workshop",
      idempotencyKey: "task-create-key",
      actionFingerprint: "jarvis-action-fingerprint:v1:abc",
      sourceRequestId: "request-task-create",
      correlationId: "correlation-task-create",
      source: "tool-action-http",
    });

    assert.equal(result.id, "task-1");
    assert.equal(result.revision, 1);
    assert.deepEqual(calls[0], {
      serviceToken: "owner-service-token",
      projectId: "project-1",
      title: "Service compressor",
      category: "workshop",
      idempotencyKey: "task-create-key",
      actionFingerprint: "jarvis-action-fingerprint:v1:abc",
      sourceRequestId: "request-task-create",
      correlationId: "correlation-task-create",
      source: "tool-action-http",
    });
  });

  it("completes, retrieves and cleans up only the requested project task", async () => {
    const calls: Array<{ kind: string; args: unknown }> = [];
    const client = {
      async query(_ref: unknown, args: unknown) {
        calls.push({ kind: "query", args });
        return taskRow({ completed: true, updatedAt: 2, revision: 2, completedAt: 2 });
      },
      async mutation(_ref: unknown, args: unknown) {
        calls.push({ kind: "mutation", args });
        const values = args as Record<string, unknown>;
        if ("idempotencyKey" in values) {
          return taskRow({ completed: true, updatedAt: 2, revision: 2, completedAt: 2 });
        }
        return true;
      },
    } as unknown as ConvexClientLike;
    const store = new ConvexControlledTaskStore(client, "owner-service-token");

    const completed = await store.complete({
      projectId: "project-1",
      taskId: "task-1",
      idempotencyKey: "task-complete-key",
      actionFingerprint: "jarvis-action-fingerprint:v1:def",
      sourceRequestId: "request-task-complete",
      correlationId: "correlation-task-complete",
      source: "tool-action-http",
    });
    const fetched = await store.get("project-1", "task-1");
    const cleaned = await store.cleanup("project-1", "task-1");

    assert.equal(completed?.completed, true);
    assert.equal(fetched?.id, "task-1");
    assert.equal(cleaned, true);
    assert.deepEqual(
      calls.map(({ args }) => args),
      [
        {
          serviceToken: "owner-service-token",
          projectId: "project-1",
          id: "task-1",
          idempotencyKey: "task-complete-key",
          actionFingerprint: "jarvis-action-fingerprint:v1:def",
          sourceRequestId: "request-task-complete",
          correlationId: "correlation-task-complete",
          source: "tool-action-http",
        },
        { serviceToken: "owner-service-token", projectId: "project-1", id: "task-1" },
        { serviceToken: "owner-service-token", projectId: "project-1", id: "task-1" },
      ],
    );
  });

  it("preserves null results and requires authentication", async () => {
    const client = {
      async query() {
        return null;
      },
      async mutation() {
        return null;
      },
    } as unknown as ConvexClientLike;
    const store = new ConvexControlledTaskStore(client, "owner-service-token");

    assert.equal(
      await store.complete({
        projectId: "project-1",
        taskId: "missing",
        idempotencyKey: "missing-key",
        actionFingerprint: "jarvis-action-fingerprint:v1:missing",
        sourceRequestId: "request-missing",
        correlationId: "correlation-missing",
        source: "test",
      }),
      null,
    );
    assert.equal(await store.get("project-1", "missing"), null);
    assert.throws(() => new ConvexControlledTaskStore(client, ""), /require JARVIS_SERVICE_TOKEN/);
  });
});
