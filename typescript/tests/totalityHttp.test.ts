import assert from "node:assert/strict";
import { afterEach, describe, it } from "node:test";

import type { NestFastifyApplication } from "@nestjs/platform-fastify";

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
import { OpenAIRequestError } from "../src/integrations/openai/totalityReasoner.js";
import {
  TotalityPipeline,
  type TotalityJournal,
  type TotalityReasoner,
} from "../src/totality/totalityPipeline.js";

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

function noOpJournal(): TotalityJournal {
  return {
    async recordValidation() {},
    async appendAudit() {},
  };
}

function successfulPipeline(journal: TotalityJournal = noOpJournal()): TotalityPipeline {
  const reasoner: TotalityReasoner = {
    async reason() {
      return {
        responseId: "response-1",
        draft: {
          answer: "Use a gusset and verify the load path.",
          assumptions: ["Steel grade is unverified."],
          unknowns: ["Peak load is unknown."],
          risks: ["Weld fatigue."],
          controls: ["Proof-load and inspect the weld profile."],
          unsupportedClaims: [],
          contradictions: [],
        },
      };
    },
  };
  return new TotalityPipeline(reasoner, journal);
}

async function makeApp(totalityPipeline: TotalityPipeline | null): Promise<NestFastifyApplication> {
  const app = await createJarvisHttpApp({
    persistence: makePersistence(),
    providerName: "json",
    config: CONFIG,
    logger: false,
    totalityPipeline,
  });
  openApps.push(app);
  return app;
}

function body(): Record<string, unknown> {
  return {
    projectId: "project-1",
    sessionId: "session-1",
    taskType: "engineering_analysis",
    domainContext: ["mechanical"],
    goal: "Review a bracket",
    constraints: [],
    inputs: [],
    outputStyle: "for_benny_engineering",
    actionPolicy: {
      maximumToolAuthority: "T1",
      requireApprovalBeforeExecution: true,
    },
  };
}

function authHeaders(): Record<string, string> {
  return {
    authorization: "Bearer current-secret",
    "x-request-id": "request-http-1",
  };
}

afterEach(async () => {
  await Promise.all(openApps.splice(0).map((app) => app.close()));
});

describe("Totality HTTP boundary", () => {
  it("requires service-token authentication", async () => {
    const app = await makeApp(successfulPipeline());
    const response = await app.inject({
      method: "POST",
      url: "/api/v1/totality/reason",
      payload: body(),
    });

    assert.equal(response.statusCode, 401);
  });

  it("returns 503 when dependencies are not configured", async () => {
    const app = await makeApp(null);
    const response = await app.inject({
      method: "POST",
      url: "/api/v1/totality/reason",
      headers: authHeaders(),
      payload: body(),
    });

    assert.equal(response.statusCode, 503);
    assert.equal(response.json().type, "urn:jarvis:problem:totality-unavailable");
  });

  it("rejects malformed request bodies", async () => {
    const app = await makeApp(successfulPipeline());
    const response = await app.inject({
      method: "POST",
      url: "/api/v1/totality/reason",
      headers: authHeaders(),
      payload: { goal: "Missing the rest" },
    });

    assert.equal(response.statusCode, 422);
    assert.equal(response.json().type, "urn:jarvis:problem:invalid-totality-request");
  });

  it("returns the validated proposal with the HTTP request ID", async () => {
    const app = await makeApp(successfulPipeline());
    const response = await app.inject({
      method: "POST",
      url: "/api/v1/totality/reason",
      headers: authHeaders(),
      payload: body(),
    });

    assert.equal(response.statusCode, 201);
    const payload = response.json();
    assert.equal(payload.requestId, "request-http-1");
    assert.equal(payload.status, "completed");
    assert.deepEqual(payload.memoryUpdates, []);
    assert.deepEqual(payload.toolActions, []);
  });

  it("maps provider rate limits without leaking provider details", async () => {
    const reasoner: TotalityReasoner = {
      async reason() {
        throw new OpenAIRequestError("sensitive upstream detail", 429, true);
      },
    };
    const app = await makeApp(new TotalityPipeline(reasoner, noOpJournal()));
    const response = await app.inject({
      method: "POST",
      url: "/api/v1/totality/reason",
      headers: authHeaders(),
      payload: body(),
    });

    assert.equal(response.statusCode, 429);
    assert.equal(response.json().type, "urn:jarvis:problem:reasoning-rate-limited");
    assert.doesNotMatch(response.body, /sensitive upstream detail/);
  });

  it("fails closed when Convex journalling fails", async () => {
    const journal: TotalityJournal = {
      async recordValidation() {
        throw new Error("Convex unavailable");
      },
      async appendAudit() {},
    };
    const app = await makeApp(successfulPipeline(journal));
    const response = await app.inject({
      method: "POST",
      url: "/api/v1/totality/reason",
      headers: authHeaders(),
      payload: body(),
    });

    assert.equal(response.statusCode, 503);
    assert.equal(response.json().type, "urn:jarvis:problem:totality-journal-failed");
  });
});
