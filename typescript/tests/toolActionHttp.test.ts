import assert from "node:assert/strict";
import { afterEach, describe, it } from "node:test";

import type { NestFastifyApplication } from "@nestjs/platform-fastify";

import type { ToolAction, ToolActionService } from "../src/actions/toolActions.js";
import { createJarvisHttpApp } from "../src/http/app.js";
import type { HttpAppConfig } from "../src/http/config.js";
import type {
  AssistantState,
  PersistenceProvider,
  Reminder,
  ReminderDue,
  ReminderUpdate,
  Task,
  TaskUpdate,
} from "../src/persistence/persistence.js";

const CONFIG: HttpAppConfig = {
  version: "0.1.0",
  sourceVersion: "test-source",
  deploymentVersion: null,
  timezone: "Australia/Melbourne",
  currentToken: "current-secret",
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
    async addReminder(_title: string, _due?: ReminderDue): Promise<Reminder> {
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

function action(state: ToolAction["state"] = "proposed"): ToolAction {
  return {
    actionId: "action-1",
    requestId: "request-http-1",
    projectId: "project-1",
    baseRevision: 3,
    state,
    tool: "calendar",
    operation: "create_event",
    arguments: { durationMinutes: 30, title: "Inspect bracket" },
    rationale: "Schedule the approved inspection.",
    requiredAuthority: "T2",
    destructive: false,
    idempotencyKey: "request-http-1:create-event",
    proposedBy: "agent",
    createdAt: "2026-07-15T00:00:00.000Z",
    updatedAt: "2026-07-15T00:00:00.000Z",
  };
}

function successfulService(overrides: Partial<ToolActionService> = {}): ToolActionService {
  return {
    async stage() {
      return action();
    },
    async get(input) {
      return input.projectId === "project-1" ? action() : null;
    },
    async list() {
      return [action()];
    },
    async approve() {
      return { ...action("approved"), approvedBy: "user" };
    },
    async reject() {
      return { ...action("rejected"), rejectedBy: "user", rejectedReason: "Not required." };
    },
    ...overrides,
  };
}

async function makeApp(service: ToolActionService | null): Promise<NestFastifyApplication> {
  const app = await createJarvisHttpApp({
    persistence: makePersistence(),
    providerName: "json",
    config: CONFIG,
    logger: false,
    totalityPipeline: null,
    memoryChangeSetService: null,
    toolActionService: service,
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

function stageBody(): Record<string, unknown> {
  return {
    actionId: "action-1",
    expectedRevision: 3,
    tool: "calendar",
    operation: "create_event",
    arguments: { title: "Inspect bracket", durationMinutes: 30 },
    rationale: "Schedule the approved inspection.",
    requiredAuthority: "T2",
    destructive: false,
    idempotencyKey: "request-http-1:create-event",
    proposedBy: "agent",
  };
}

afterEach(async () => {
  await Promise.all(openApps.splice(0).map((app) => app.close()));
});

describe("Tool action approval HTTP boundary", () => {
  it("requires service-token authentication", async () => {
    const app = await makeApp(successfulService());
    const response = await app.inject({
      method: "POST",
      url: "/api/v1/projects/project-1/tool-actions",
      payload: stageBody(),
    });

    assert.equal(response.statusCode, 401);
  });

  it("returns 503 when the approval service is unavailable", async () => {
    const app = await makeApp(null);
    const response = await app.inject({
      method: "POST",
      url: "/api/v1/projects/project-1/tool-actions",
      headers: authHeaders(),
      payload: stageBody(),
    });

    assert.equal(response.statusCode, 503);
    assert.equal(response.json().type, "urn:jarvis:problem:tool-action-approval-unavailable");
  });

  it("stages a proposal with the HTTP request ID", async () => {
    const captured: Array<Parameters<ToolActionService["stage"]>[0]> = [];
    const app = await makeApp(
      successfulService({
        async stage(input) {
          captured.push(input);
          return action();
        },
      }),
    );
    const response = await app.inject({
      method: "POST",
      url: "/api/v1/projects/project-1/tool-actions",
      headers: authHeaders(),
      payload: stageBody(),
    });

    assert.equal(response.statusCode, 201);
    assert.equal(captured[0]?.requestId, "request-http-1");
    assert.equal(captured[0]?.projectId, "project-1");
    assert.equal(captured[0]?.expectedRevision, 3);
    assert.deepEqual(captured[0]?.arguments, {
      durationMinutes: 30,
      title: "Inspect bracket",
    });
  });

  it("rejects insufficient or mismatched authority before calling the service", async () => {
    let called = false;
    const app = await makeApp(
      successfulService({
        async stage() {
          called = true;
          return action();
        },
      }),
    );

    const t0Response = await app.inject({
      method: "POST",
      url: "/api/v1/projects/project-1/tool-actions",
      headers: authHeaders(),
      payload: { ...stageBody(), requiredAuthority: "T0" },
    });
    const destructiveResponse = await app.inject({
      method: "POST",
      url: "/api/v1/projects/project-1/tool-actions",
      headers: authHeaders(),
      payload: { ...stageBody(), destructive: true, requiredAuthority: "T2" },
    });

    assert.equal(t0Response.statusCode, 422);
    assert.equal(destructiveResponse.statusCode, 422);
    assert.equal(called, false);
  });

  it("rejects credential-shaped arguments before calling the service", async () => {
    let called = false;
    const app = await makeApp(
      successfulService({
        async stage() {
          called = true;
          return action();
        },
      }),
    );

    const response = await app.inject({
      method: "POST",
      url: "/api/v1/projects/project-1/tool-actions",
      headers: authHeaders(),
      payload: {
        ...stageBody(),
        arguments: { apiKey: "must-not-be-stored" },
      },
    });

    assert.equal(response.statusCode, 422);
    assert.equal(called, false);
    assert.doesNotMatch(response.body, /must-not-be-stored/);
  });

  it("passes state and limit filters to the service", async () => {
    let captured: Parameters<ToolActionService["list"]>[0] | null = null;
    const app = await makeApp(
      successfulService({
        async list(input) {
          captured = input;
          return [action("approved")];
        },
      }),
    );
    const response = await app.inject({
      method: "GET",
      url: "/api/v1/projects/project-1/tool-actions?state=approved&limit=10",
      headers: authHeaders(),
    });

    assert.equal(response.statusCode, 200);
    assert.deepEqual(captured, { projectId: "project-1", state: "approved", limit: 10 });
  });

  it("returns 404 when the action belongs to another project", async () => {
    const app = await makeApp(successfulService());
    const response = await app.inject({
      method: "GET",
      url: "/api/v1/projects/project-2/tool-actions/action-1",
      headers: authHeaders(),
    });

    assert.equal(response.statusCode, 404);
    assert.equal(response.json().type, "urn:jarvis:problem:tool-action-not-found");
  });

  it("approves without executing the action", async () => {
    let approved = false;
    const app = await makeApp(
      successfulService({
        async approve() {
          approved = true;
          return { ...action("approved"), approvedBy: "user" };
        },
      }),
    );
    const response = await app.inject({
      method: "POST",
      url: "/api/v1/projects/project-1/tool-actions/action-1/approve",
      headers: authHeaders(),
      payload: { expectedRevision: 3 },
    });

    assert.equal(response.statusCode, 200);
    assert.equal(approved, true);
    assert.equal(response.json().state, "approved");
    assert.equal(response.json().executedAt, undefined);
  });

  it("rejects a proposal with a reason", async () => {
    let reason = "";
    const app = await makeApp(
      successfulService({
        async reject(input) {
          reason = input.reason;
          return {
            ...action("rejected"),
            rejectedBy: "user",
            rejectedReason: input.reason,
          };
        },
      }),
    );
    const response = await app.inject({
      method: "POST",
      url: "/api/v1/projects/project-1/tool-actions/action-1/reject",
      headers: authHeaders(),
      payload: { reason: "Not required." },
    });

    assert.equal(response.statusCode, 200);
    assert.equal(reason, "Not required.");
    assert.equal(response.json().state, "rejected");
  });

  it("maps revision conflicts without leaking backend details", async () => {
    const app = await makeApp(
      successfulService({
        async approve() {
          throw new Error("Project revision conflict: expected 3, current 4. token=current-secret");
        },
      }),
    );
    const response = await app.inject({
      method: "POST",
      url: "/api/v1/projects/project-1/tool-actions/action-1/approve",
      headers: authHeaders(),
      payload: { expectedRevision: 3 },
    });

    assert.equal(response.statusCode, 409);
    assert.equal(response.json().type, "urn:jarvis:problem:tool-action-revision-conflict");
    assert.doesNotMatch(response.body, /current-secret|current 4/);
  });

  it("has no execution route in this stage", async () => {
    const app = await makeApp(successfulService());
    const response = await app.inject({
      method: "POST",
      url: "/api/v1/projects/project-1/tool-actions/action-1/execute",
      headers: authHeaders(),
      payload: {},
    });

    assert.equal(response.statusCode, 404);
  });
});
