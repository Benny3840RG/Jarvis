import assert from "node:assert/strict";
import { describe, it } from "node:test";

import type { NestFastifyApplication } from "@nestjs/platform-fastify";

import { createJarvisHttpApp } from "../src/http/app.js";
import type { PostHogTelemetry } from "../src/observability/posthog.js";
import type {
  AssistantState,
  PersistenceProvider,
  Reminder,
  ReminderUpdate,
  Task,
  TaskUpdate,
} from "../src/persistence/persistence.js";
import { runPostHogCommissioning } from "../src/tools/runPostHogCommissioning.js";

function telemetry(enabled = true): PostHogTelemetry & { flushCount: number; events: string[] } {
  return {
    enabled,
    flushCount: 0,
    events: [],
    capture(event) {
      this.events.push(event.event);
    },
    async flush() {
      this.flushCount += 1;
    },
  };
}

function persistence(): PersistenceProvider {
  const task: Task = {
    id: "task-1",
    title: "Test",
    completed: false,
    category: "test",
    createdAt: 1,
  };
  const reminder: Reminder = { id: "reminder-1", title: "Test", createdAt: 1 };
  return {
    async loadState(): Promise<AssistantState> {
      return {};
    },
    async saveState(): Promise<void> {},
    async listTasks(): Promise<Task[]> {
      return [];
    },
    async addTask(title: string, category: string): Promise<Task> {
      return { ...task, title, category };
    },
    async updateTask(_id: string, _update: TaskUpdate): Promise<Task | null> {
      return task;
    },
    async completeTask(): Promise<Task | null> {
      return task;
    },
    async removeTask(): Promise<Task | null> {
      return task;
    },
    async listReminders(): Promise<Reminder[]> {
      return [];
    },
    async addReminder(): Promise<Reminder> {
      return reminder;
    },
    async updateReminder(_id: string, _update: ReminderUpdate): Promise<Reminder | null> {
      return reminder;
    },
    async removeReminder(): Promise<Reminder | null> {
      return reminder;
    },
  };
}

describe("PostHog commissioning", () => {
  it("uses the real HTTP health boundary, flushes telemetry, and closes the app", async () => {
    const observed: string[] = [];
    const sink = telemetry();
    const app = {
      async inject(input: { method: string; url: string }) {
        observed.push(`${input.method} ${input.url}`);
        return { statusCode: 200 };
      },
      async close() {
        observed.push("closed");
      },
    } as unknown as NestFastifyApplication;

    const receipt = await runPostHogCommissioning(sink, async () => app);

    assert.deepEqual(observed, ["GET /healthz", "closed"]);
    assert.equal(sink.flushCount, 1);
    assert.deepEqual(receipt, { statusCode: 200, telemetryFlushed: true });
  });

  it("emits the three governed events through the actual HTTP response hook", async () => {
    const sink = telemetry();

    const receipt = await runPostHogCommissioning(sink, () =>
      createJarvisHttpApp({
        persistence: persistence(),
        providerName: "json",
        config: {
          version: "0.1.0",
          sourceVersion: "commissioning-test",
          deploymentVersion: null,
        },
        externalReconciliationReadStore: null,
        totalityPipeline: null,
        memoryChangeSetService: null,
        toolActionService: null,
        toolExecutionService: null,
        quoteRepository: null,
        quoteDeliveryRepository: null,
        activityEventReader: null,
        telemetry: sink,
        logger: false,
      }),
    );

    assert.equal(receipt.statusCode, 200);
    assert.deepEqual(sink.events, [
      "jarvis.operator_action",
      "jarvis.boundary_latency",
      "jarvis.usage",
    ]);
  });

  it("fails closed before starting an app when telemetry is disabled", async () => {
    const sink = telemetry(false);
    let created = false;

    await assert.rejects(
      runPostHogCommissioning(sink, async () => {
        created = true;
        throw new Error("must not start");
      }),
      /PostHog telemetry is not enabled/,
    );
    assert.equal(created, false);
    assert.equal(sink.flushCount, 0);
  });

  it("flushes telemetry and closes the app even when health is not OK", async () => {
    const observed: string[] = [];
    const sink = telemetry();
    const app = {
      async inject() {
        return { statusCode: 503 };
      },
      async close() {
        observed.push("closed");
      },
    } as unknown as NestFastifyApplication;

    await assert.rejects(
      runPostHogCommissioning(sink, async () => app),
      /returned HTTP 503/,
    );
    assert.deepEqual(observed, ["closed"]);
    assert.equal(sink.flushCount, 1);
  });
});
