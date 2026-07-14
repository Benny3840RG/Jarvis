import assert from "node:assert/strict";
import { afterEach, describe, it } from "node:test";

import type { NestFastifyApplication } from "@nestjs/platform-fastify";

import { createJarvisHttpApp } from "../src/http/app.js";
import type { HttpAppConfig } from "../src/http/config.js";
import type {
  ApplyMemoryChangeSetResult,
  MemoryChangeSet,
  MemoryChangeSetService,
} from "../src/memory/memoryChangeSets.js";
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
  previousToken: null,
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

function changeSet(state: MemoryChangeSet["state"] = "proposed"): MemoryChangeSet {
  return {
    changeSetId: "change-1",
    requestId: "request-http-1",
    projectId: "project-1",
    baseRevision: 3,
    state,
    records: [
      {
        kind: "fact",
        recordId: "fact-1",
        statement: "Bracket thickness is 6 mm.",
        source: "measurement",
        confidence: 1,
        recordedAt: "2026-07-15T00:00:00.000Z",
      },
    ],
    rationale: "Record the verified bracket measurement.",
    proposedBy: "user",
    createdAt: "2026-07-15T00:00:00.000Z",
    updatedAt: "2026-07-15T00:00:00.000Z",
  };
}

function successfulService(overrides: Partial<MemoryChangeSetService> = {}): MemoryChangeSetService {
  return {
    async stage() {
      return changeSet();
    },
    async get() {
      return changeSet();
    },
    async list() {
      return [changeSet()];
    },
    async approve() {
      return changeSet("approved");
    },
    async reject() {
      return changeSet("rejected");
    },
    async apply(): Promise<ApplyMemoryChangeSetResult> {
      return {
        changeSet: { ...changeSet("applied"), appliedRevision: 4 },
        projectRevision: 4,
        records: [
          {
            recordId: "fact-1",
            projectId: "project-1",
            kind: "fact",
            record: changeSet().records[0],
            updatedAt: "2026-07-15T00:00:01.000Z",
          },
        ],
        idempotent: false,
      };
    },
    ...overrides,
  };
}

async function makeApp(service: MemoryChangeSetService | null): Promise<NestFastifyApplication> {
  const app = await createJarvisHttpApp({
    persistence: makePersistence(),
    providerName: "json",
    config: CONFIG,
    logger: false,
    totalityPipeline: null,
    memoryChangeSetService: service,
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
    changeSetId: "change-1",
    expectedRevision: 3,
    records: changeSet().records,
    rationale: "Record the verified bracket measurement.",
    proposedBy: "user",
  };
}

afterEach(async () => {
  await Promise.all(openApps.splice(0).map((app) => app.close()));
});

describe("Memory change set HTTP boundary", () => {
  it("requires service-token authentication", async () => {
    const app = await makeApp(successfulService());
    const response = await app.inject({
      method: "POST",
      url: "/api/v1/projects/project-1/memory-change-sets",
      payload: stageBody(),
    });
    assert.equal(response.statusCode, 401);
  });

  it("returns 503 when Convex memory approval is unavailable", async () => {
    const app = await makeApp(null);
    const response = await app.inject({
      method: "POST",
      url: "/api/v1/projects/project-1/memory-change-sets",
      headers: authHeaders(),
      payload: stageBody(),
    });
    assert.equal(response.statusCode, 503);
    assert.equal(response.json().type, "urn:jarvis:problem:memory-approval-unavailable");
  });

  it("stages a typed proposal with the HTTP request ID", async () => {
    let captured: Parameters<MemoryChangeSetService["stage"]>[0] | null = null;
    const app = await makeApp(
      successfulService({
        async stage(input) {
          captured = input;
          return changeSet();
        },
      }),
    );
    const response = await app.inject({
      method: "POST",
      url: "/api/v1/projects/project-1/memory-change-sets",
      headers: authHeaders(),
      payload: stageBody(),
    });
    assert.equal(response.statusCode, 201);
    assert.equal(captured?.requestId, "request-http-1");
    assert.equal(captured?.projectId, "project-1");
    assert.equal(captured?.expectedRevision, 3);
  });

  it("rejects unsupported record kinds before calling the service", async () => {
    let called = false;
    const app = await makeApp(
      successfulService({
        async stage() {
          called = true;
          return changeSet();
        },
      }),
    );
    const response = await app.inject({
      method: "POST",
      url: "/api/v1/projects/project-1/memory-change-sets",
      headers: authHeaders(),
      payload: {
        ...stageBody(),
        records: [{ kind: "task", recordId: "task-1" }],
      },
    });
    assert.equal(response.statusCode, 422);
    assert.equal(called, false);
  });

  it("passes state and limit filters to the service", async () => {
    let captured: Parameters<MemoryChangeSetService["list"]>[0] | null = null;
    const app = await makeApp(
      successfulService({
        async list(input) {
          captured = input;
          return [changeSet("approved")];
        },
      }),
    );
    const response = await app.inject({
      method: "GET",
      url: "/api/v1/projects/project-1/memory-change-sets?state=approved&limit=10",
      headers: authHeaders(),
    });
    assert.equal(response.statusCode, 200);
    assert.deepEqual(captured, { projectId: "project-1", state: "approved", limit: 10 });
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
      url: "/api/v1/projects/project-1/memory-change-sets/change-1/approve",
      headers: authHeaders(),
      payload: { expectedRevision: 3 },
    });
    assert.equal(response.statusCode, 409);
    assert.equal(response.json().type, "urn:jarvis:problem:memory-revision-conflict");
    assert.doesNotMatch(response.body, /current-secret|current 4/);
  });

  it("returns a transactionally applied result", async () => {
    const app = await makeApp(successfulService());
    const response = await app.inject({
      method: "POST",
      url: "/api/v1/projects/project-1/memory-change-sets/change-1/apply",
      headers: authHeaders(),
      payload: { expectedRevision: 3 },
    });
    assert.equal(response.statusCode, 200);
    const payload = response.json();
    assert.equal(payload.changeSet.state, "applied");
    assert.equal(payload.projectRevision, 4);
    assert.equal(payload.idempotent, false);
  });
});
