import assert from "node:assert/strict";
import { afterEach, describe, it } from "node:test";

import type { NestFastifyApplication } from "@nestjs/platform-fastify";

import { createJarvisHttpApp } from "../src/http/app.js";
import type { HttpAppConfig } from "../src/http/config.js";
import { OpenAIRequestError } from "../src/integrations/openai/totalityReasoner.js";
import type {
  AssistantState,
  PersistenceProvider,
  Reminder,
  ReminderDue,
  ReminderUpdate,
  Task,
  TaskUpdate,
} from "../src/persistence/persistence.js";
import {
  TotalityPipeline,
  type TotalityJournal,
  type TotalityProjectContext,
  type TotalityReasoner,
} from "../src/totality/totalityPipeline.js";
import { TotalityQuota } from "../src/totality/totalityQuota.js";

const CONFIG: HttpAppConfig = {
  version: "0.1.0",
  sourceVersion: "test-source",
  deploymentVersion: null,
  timezone: "Australia/Melbourne",
  currentToken: "current-secret",
  previousToken: undefined,
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

function projectContext(): TotalityProjectContext {
  return {
    projectId: "project-1",
    projectName: "Bracket review",
    projectType: "engineering",
    status: "active",
    revision: 4,
    domains: ["mechanical"],
    summary: "Review a fabricated bracket.",
    updatedAt: "2026-07-15T23:00:00.000Z",
  };
}

function noOpJournal(): TotalityJournal {
  return {
    async getProjectContext() {
      return projectContext();
    },
    async commitOutcome(input) {
      return {
        memoryChangeSetId:
          input.memoryProposal === undefined ? null : input.memoryProposal.changeSetId,
      };
    },
  };
}

function successfulPipeline(
  journal: TotalityJournal = noOpJournal(),
  memoryProposals: Awaited<ReturnType<TotalityReasoner["reason"]>>["draft"]["memoryProposals"] = [],
  quota?: TotalityQuota,
): TotalityPipeline {
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
          memoryProposals,
          memoryRationale:
            memoryProposals.length === 0 ? "" : "Retain the proposal for explicit approval.",
        },
      };
    },
  };
  return new TotalityPipeline(reasoner, journal, () => new Date("2026-07-16T00:00:00.000Z"), quota);
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

    assert.equal(response.statusCode, 200);
    const payload = response.json();
    assert.equal(payload.requestId, "request-http-1");
    assert.equal(payload.status, "completed");
    assert.equal(payload.result.memoryChangeSetId, null);
    assert.equal(payload.result.memoryProposalCount, 0);
    assert.deepEqual(payload.memoryUpdates, []);
    assert.deepEqual(payload.toolActions, []);
  });

  it("returns staged memory proposal metadata without applying it", async () => {
    const app = await makeApp(
      successfulPipeline(noOpJournal(), [
        {
          kind: "assumption",
          statement: "Peak load remains unverified.",
          impact: "high",
        },
      ]),
    );
    const response = await app.inject({
      method: "POST",
      url: "/api/v1/totality/reason",
      headers: authHeaders(),
      payload: body(),
    });

    assert.equal(response.statusCode, 200);
    const payload = response.json();
    assert.match(payload.result.memoryChangeSetId, /^reasoning-/);
    assert.equal(payload.result.memoryProposalCount, 1);
    assert.equal(payload.memoryUpdates.length, 1);
    assert.equal(payload.memoryUpdates[0].requiresApproval, true);
  });

  it("returns 404 when authoritative project context is missing", async () => {
    const journal: TotalityJournal = {
      async getProjectContext() {
        return null;
      },
      async commitOutcome() {
        return { memoryChangeSetId: null };
      },
    };
    const app = await makeApp(successfulPipeline(journal));
    const response = await app.inject({
      method: "POST",
      url: "/api/v1/totality/reason",
      headers: authHeaders(),
      payload: body(),
    });

    assert.equal(response.statusCode, 404);
    assert.equal(response.json().type, "urn:jarvis:problem:totality-project-not-found");
  });

  it("returns 409 when the project revision moves before atomic staging", async () => {
    const journal: TotalityJournal = {
      async getProjectContext() {
        return projectContext();
      },
      async commitOutcome() {
        throw new Error("Project revision conflict: expected 4, current 5.");
      },
    };
    const app = await makeApp(
      successfulPipeline(journal, [
        {
          kind: "assumption",
          statement: "Peak load remains unverified.",
          impact: "high",
        },
      ]),
    );
    const response = await app.inject({
      method: "POST",
      url: "/api/v1/totality/reason",
      headers: authHeaders(),
      payload: body(),
    });

    assert.equal(response.statusCode, 409);
    assert.equal(response.json().type, "urn:jarvis:problem:memory-proposal-conflict");
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

  it("distinguishes rejected provider credentials without leaking provider details", async () => {
    const reasoner: TotalityReasoner = {
      async reason() {
        throw new OpenAIRequestError("sensitive credential detail", 401, false);
      },
    };
    const app = await makeApp(new TotalityPipeline(reasoner, noOpJournal()));
    const response = await app.inject({
      method: "POST",
      url: "/api/v1/totality/reason",
      headers: authHeaders(),
      payload: body(),
    });

    assert.equal(response.statusCode, 503);
    assert.equal(response.json().type, "urn:jarvis:problem:reasoning-authentication-failed");
    assert.doesNotMatch(response.body, /sensitive credential detail/);
  });

  it("distinguishes rejected provider requests without leaking provider details", async () => {
    const reasoner: TotalityReasoner = {
      async reason() {
        throw new OpenAIRequestError("sensitive request detail", 400, false);
      },
    };
    const app = await makeApp(new TotalityPipeline(reasoner, noOpJournal()));
    const response = await app.inject({
      method: "POST",
      url: "/api/v1/totality/reason",
      headers: authHeaders(),
      payload: body(),
    });

    assert.equal(response.statusCode, 503);
    assert.equal(response.json().type, "urn:jarvis:problem:reasoning-request-rejected");
    assert.doesNotMatch(response.body, /sensitive request detail/);
  });

  it("rejects aggregate Totality quota exhaustion before provider work", async () => {
    const app = await makeApp(
      successfulPipeline(
        noOpJournal(),
        [],
        new TotalityQuota({
          maxRequestBytes: 128,
          maxEstimatedInputTokens: 32,
          maxConcurrentRequests: 1,
          maxCostUnitsPerWindow: 1_024,
          maxOutputTokens: 256,
          windowMs: 60_000,
        }),
      ),
    );
    const response = await app.inject({
      method: "POST",
      url: "/api/v1/totality/reason",
      headers: authHeaders(),
      payload: body(),
    });

    assert.equal(response.statusCode, 413);
    assert.equal(response.json().type, "urn:jarvis:problem:totality-request-too-large");
  });

  it("fails closed when the atomic Convex journal commit fails", async () => {
    const journal: TotalityJournal = {
      async getProjectContext() {
        return projectContext();
      },
      async commitOutcome() {
        throw new Error("Convex unavailable");
      },
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
