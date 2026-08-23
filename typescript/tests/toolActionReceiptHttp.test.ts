import assert from "node:assert/strict";
import { afterEach, describe, it } from "node:test";

import type { NestFastifyApplication } from "@nestjs/platform-fastify";

import type { ToolAction, ToolActionService } from "../src/actions/toolActions.js";
import {
  deriveToolExecutionIdempotencyKey,
  InMemoryToolExecutionReceiptStore,
  type ToolExecutionReceipt,
} from "../src/actions/toolExecution.js";
import { createJarvisHttpApp } from "../src/http/app.js";
import type { HttpAppConfig } from "../src/http/config.js";
import type {
  AssistantState,
  PersistenceProvider,
  Reminder,
  Task,
} from "../src/persistence/persistence.js";

const CONFIG: HttpAppConfig = {
  version: "0.1.0",
  sourceVersion: "test-source",
  deploymentVersion: null,
  timezone: "Australia/Melbourne",
  currentToken: "current-secret",
  currentApprovalToken: "approval-secret",
};

const openApps: NestFastifyApplication[] = [];

function makePersistence(): PersistenceProvider {
  const task: Task = {
    id: "task-1",
    title: "Task",
    completed: false,
    category: "test",
    createdAt: 1,
  };
  const reminder: Reminder = { id: "reminder-1", title: "Reminder", createdAt: 1 };
  return {
    async loadState(): Promise<AssistantState> {
      return {};
    },
    async saveState(): Promise<void> {},
    async listTasks(): Promise<Task[]> {
      return [];
    },
    async addTask(): Promise<Task> {
      return task;
    },
    async updateTask(): Promise<Task | null> {
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
    async updateReminder(): Promise<Reminder | null> {
      return reminder;
    },
    async removeReminder(): Promise<Reminder | null> {
      return reminder;
    },
  };
}

function action(projectId = "project-1"): ToolAction {
  return {
    actionId: "action-1",
    requestId: "request-http-1",
    projectId,
    baseRevision: 3,
    state: "approved",
    tool: "notes",
    operation: "create",
    arguments: { body: "note" },
    rationale: "Record the note.",
    requiredAuthority: "T1",
    destructive: false,
    idempotencyKey: "request-http-1:note",
    proposedBy: "agent",
    createdAt: "2026-08-23T00:00:00.000Z",
    updatedAt: "2026-08-23T00:00:00.000Z",
  };
}

function receipt(
  mode: "live" | "dry-run",
  status: ToolExecutionReceipt["status"],
  overrides: Partial<ToolExecutionReceipt> = {},
): ToolExecutionReceipt {
  const idempotencyKey = deriveToolExecutionIdempotencyKey("action-1", mode);
  return {
    receiptId: `${mode}-receipt`,
    actionId: "action-1",
    requestId: "request-http-1",
    projectId: "project-1",
    idempotencyKey,
    actionFingerprint: "jarvis-action-fingerprint:v1:test",
    tool: "notes",
    operation: "create",
    actor: "agent",
    policyVersion: "totality-policy:v2.2",
    correlationId: `${mode}-correlation`,
    source: "receipt-http-test",
    status,
    startedAt: "2026-08-23T00:00:00.000Z",
    completedAt: mode === "live" ? "2026-08-23T00:00:02.000Z" : "2026-08-23T00:00:01.000Z",
    ...overrides,
  };
}

function successfulService(overrides: Partial<ToolActionService> = {}): ToolActionService {
  return {
    async stage() {
      return action();
    },
    async get(input) {
      if (input.actionId !== "action-1") return null;
      return input.projectId === "project-1" ? action() : null;
    },
    async list() {
      return [action()];
    },
    async approve() {
      return action();
    },
    async reject() {
      return action();
    },
    ...overrides,
  };
}

async function makeApp(
  receipts: InMemoryToolExecutionReceiptStore | null,
  service: ToolActionService | null = successfulService(),
): Promise<NestFastifyApplication> {
  const app = await createJarvisHttpApp({
    persistence: makePersistence(),
    providerName: "json",
    config: CONFIG,
    logger: false,
    totalityPipeline: null,
    memoryChangeSetService: null,
    toolActionService: service,
    toolExecutionService: null,
    toolExecutionReceiptStore: receipts,
  });
  openApps.push(app);
  return app;
}

function authHeaders(): Record<string, string> {
  return {
    authorization: "Bearer current-secret",
    "x-request-id": "request-http-1",
  };
}

afterEach(async () => {
  while (openApps.length) {
    const app = openApps.pop();
    if (app) await app.close();
  }
});

describe("tool action receipt inspection HTTP", () => {
  it("returns 503 when receipt observation is unavailable", async () => {
    const app = await makeApp(null);
    const response = await app.inject({
      method: "GET",
      url: "/api/v1/projects/project-1/tool-actions/action-1/receipts",
      headers: authHeaders(),
    });
    assert.equal(response.statusCode, 503);
  });

  it("returns an empty live receipt when the read succeeds and no receipts exist", async () => {
    const app = await makeApp(new InMemoryToolExecutionReceiptStore());
    const response = await app.inject({
      method: "GET",
      url: "/api/v1/projects/project-1/tool-actions/action-1/receipts",
      headers: authHeaders(),
    });
    assert.equal(response.statusCode, 200);
    const body = JSON.parse(response.body) as {
      count: number;
      liveReceipt: unknown;
      data: unknown[];
    };
    assert.equal(body.count, 0);
    assert.equal(body.liveReceipt, null);
    assert.deepEqual(body.data, []);
  });

  it("does not treat a dry-run success as live execution evidence", async () => {
    const store = new InMemoryToolExecutionReceiptStore();
    const dry = receipt("dry-run", "dry-run");
    await store.save(dry.idempotencyKey, dry);
    const app = await makeApp(store);
    const response = await app.inject({
      method: "GET",
      url: "/api/v1/projects/project-1/tool-actions/action-1/receipts",
      headers: authHeaders(),
    });
    const body = JSON.parse(response.body) as {
      count: number;
      liveReceipt: { executionMode: string } | null;
      data: Array<{ executionMode: string; status: string }>;
    };
    assert.equal(response.statusCode, 200);
    assert.equal(body.count, 1);
    assert.equal(body.data[0]?.executionMode, "dry-run");
    assert.equal(body.liveReceipt, null);
  });

  it("selects the live receipt when dry-run and live coexist", async () => {
    const store = new InMemoryToolExecutionReceiptStore();
    const dry = receipt("dry-run", "dry-run");
    const live = receipt("live", "succeeded");
    await store.save(dry.idempotencyKey, dry);
    await store.save(live.idempotencyKey, live);
    const app = await makeApp(store);
    const response = await app.inject({
      method: "GET",
      url: "/api/v1/projects/project-1/tool-actions/action-1/receipts",
      headers: authHeaders(),
    });
    const body = JSON.parse(response.body) as {
      count: number;
      liveReceipt: { executionMode: string; status: string; receiptId: string } | null;
    };
    assert.equal(body.count, 2);
    assert.equal(body.liveReceipt?.executionMode, "live");
    assert.equal(body.liveReceipt?.status, "succeeded");
    assert.equal(body.liveReceipt?.receiptId, "live-receipt");
  });

  it("returns 404 for a wrong action ID or project mismatch", async () => {
    const store = new InMemoryToolExecutionReceiptStore();
    const app = await makeApp(store);
    const missing = await app.inject({
      method: "GET",
      url: "/api/v1/projects/project-1/tool-actions/missing-action/receipts",
      headers: authHeaders(),
    });
    assert.equal(missing.statusCode, 404);
    const mismatch = await app.inject({
      method: "GET",
      url: "/api/v1/projects/other-project/tool-actions/action-1/receipts",
      headers: authHeaders(),
    });
    assert.equal(mismatch.statusCode, 404);
  });
});
