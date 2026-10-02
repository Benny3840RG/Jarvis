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
} from "../src/persistence/persistence.js";
import { captureCredentials, type CredentialsRuntime } from "../src/settings/credentialsStatus.js";

const openApps: NestFastifyApplication[] = [];
const SERVICE_TOKEN = "hud-service-token-value";

function persistence(): PersistenceProvider {
  const tasks: Task[] = [
    { id: "task-1", title: "Clear the deck", category: "personal", completed: false, createdAt: 1 },
  ];
  return {
    async loadState(): Promise<AssistantState> {
      return {};
    },
    async saveState(): Promise<void> {},
    async listTasks(): Promise<Task[]> {
      return tasks;
    },
    async addTask(title: string, category: string): Promise<Task> {
      return { id: "task-2", title, category, completed: false, createdAt: 2 };
    },
    async updateTask(): Promise<Task | null> {
      return null;
    },
    async completeTask(): Promise<Task | null> {
      return null;
    },
    async removeTask(): Promise<Task | null> {
      return null;
    },
    async listReminders(): Promise<Reminder[]> {
      return [];
    },
    async addReminder(title: string, _due?: ReminderDue): Promise<Reminder> {
      return { id: "reminder-1", title, createdAt: 1 };
    },
    async updateReminder(_id: string, _update: ReminderUpdate): Promise<Reminder | null> {
      return null;
    },
    async removeReminder(): Promise<Reminder | null> {
      return null;
    },
  };
}

function config(): HttpAppConfig {
  return {
    version: "0.1.0",
    sourceVersion: "hud-test",
    deploymentVersion: null,
    timezone: "Australia/Melbourne",
    currentToken: SERVICE_TOKEN,
  };
}

function credentials(host: string): CredentialsRuntime {
  return captureCredentials({
    serviceToken: SERVICE_TOKEN,
    httpHost: host,
    httpPort: 3000,
    mcpHost: "127.0.0.1",
    mcpPort: 8787,
    remoteGatewayEnabled: false,
    tlsTerminated: false,
    oidcConfigured: false,
    originsConfigured: false,
    persistenceProvider: "json",
  });
}

async function open(host: string): Promise<NestFastifyApplication> {
  const app = await createJarvisHttpApp({
    config: config(),
    credentialsRuntime: credentials(host),
    persistence: persistence(),
    providerName: "json",
    logger: false,
  });
  openApps.push(app);
  return app;
}

afterEach(async () => {
  await Promise.all(openApps.splice(0).map((item) => item.close()));
});

describe("loopback Console 02 HUD", () => {
  it("serves the HUD and a read-only snapshot on loopback without a token", async () => {
    const app = await open("127.0.0.1");
    const page = await app.inject({ method: "GET", url: "/hud" });
    assert.equal(page.statusCode, 200);
    assert.match(page.headers["content-type"] ?? "", /text\/html/);
    assert.match(String(page.headers["content-security-policy"]), /connect-src 'self'/);
    assert.match(page.body, /CONSOLE 02/);
    assert.match(page.body, /JARVIS TOTALITY/);
    assert.doesNotMatch(page.body, new RegExp(SERVICE_TOKEN));
    assert.equal(page.headers["cache-control"], "no-store");

    const snapshot = await app.inject({
      method: "GET",
      url: "/api/v1/hud/snapshot",
      headers: { accept: "application/json" },
    });
    assert.equal(snapshot.statusCode, 200);
    const body = snapshot.json<{
      tasks: Array<{ title: string }>;
      counts: { activeTasks: number };
      credentials: { tokens: Array<{ fingerprint: string }> };
      activity: { status: string };
      liveWork: { status: string };
    }>();
    assert.equal(body.tasks[0]?.title, "Clear the deck");
    assert.equal(body.counts.activeTasks, 1);
    assert.equal(body.activity.status, "unavailable");
    assert.equal(body.liveWork.status, "unavailable");
    assert.equal(typeof body.credentials.tokens[0]?.fingerprint, "string");
    assert.doesNotMatch(snapshot.body, new RegExp(SERVICE_TOKEN));
    assert.doesNotMatch(snapshot.body, /serviceDigests/);
  });

  it("does not serve the HUD off loopback", async () => {
    const app = await open("10.1.1.1");
    const page = await app.inject({ method: "GET", url: "/hud" });
    const snapshot = await app.inject({ method: "GET", url: "/api/v1/hud/snapshot" });
    assert.equal(page.statusCode, 404);
    assert.equal(snapshot.statusCode, 404);
  });
});
