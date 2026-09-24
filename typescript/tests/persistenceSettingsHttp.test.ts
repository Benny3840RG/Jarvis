import assert from "node:assert/strict";
import { afterEach, describe, it } from "node:test";

import type { NestFastifyApplication } from "@nestjs/platform-fastify";

import { createJarvisHttpApp } from "../src/http/app.js";
import type { HttpAppConfig } from "../src/http/config.js";
import type { PersistenceProvider } from "../src/persistence/persistence.js";

const CONFIG: HttpAppConfig = {
  version: "0.1.0",
  sourceVersion: "persistence-settings-http",
  deploymentVersion: null,
  timezone: "Australia/Melbourne",
  currentToken: "current-secret",
  previousToken: undefined,
};

function persistence(): PersistenceProvider {
  return {
    async loadState() {
      return {};
    },
    async saveState() {},
    async listTasks() {
      return [];
    },
    async addTask(title: string) {
      return { id: "task-1", title, category: "personal", completed: false, createdAt: 1 };
    },
    async updateTask() {
      return null;
    },
    async completeTask() {
      return null;
    },
    async removeTask() {
      return null;
    },
    async listReminders() {
      return [];
    },
    async addReminder(title: string) {
      return { id: "reminder-1", title, createdAt: 1 };
    },
    async updateReminder() {
      return null;
    },
    async removeReminder() {
      return null;
    },
  };
}

const openApps: NestFastifyApplication[] = [];
const ORIGINAL_PROVIDER = process.env.PERSISTENCE_PROVIDER;
const ORIGINAL_DEPLOYMENT = process.env.CONVEX_DEPLOYMENT;

async function makeApp(providerName: "json" | "convex") {
  const app = await createJarvisHttpApp({
    persistence: persistence(),
    providerName,
    config: CONFIG,
    logger: false,
  });
  openApps.push(app);
  return app;
}

afterEach(async () => {
  if (ORIGINAL_PROVIDER === undefined) delete process.env.PERSISTENCE_PROVIDER;
  else process.env.PERSISTENCE_PROVIDER = ORIGINAL_PROVIDER;
  if (ORIGINAL_DEPLOYMENT === undefined) delete process.env.CONVEX_DEPLOYMENT;
  else process.env.CONVEX_DEPLOYMENT = ORIGINAL_DEPLOYMENT;
  await Promise.all(openApps.splice(0).map((app) => app.close()));
});

describe("Persistence settings HTTP", () => {
  it("requires authentication", async () => {
    process.env.PERSISTENCE_PROVIDER = "json";
    const app = await makeApp("json");
    const response = await app.inject({ method: "GET", url: "/api/v1/settings/persistence" });
    assert.equal(response.statusCode, 401);
  });

  it("reports Convex from the environment and refuses v4 export without a JSON fallback", async () => {
    process.env.PERSISTENCE_PROVIDER = "convex";
    process.env.CONVEX_DEPLOYMENT = "dev:settings";
    const app = await makeApp("convex");
    const read = await app.inject({
      method: "GET",
      url: "/api/v1/settings/persistence",
      headers: { authorization: "Bearer current-secret" },
    });
    assert.equal(read.statusCode, 200);
    const view = read.json();
    assert.equal(view.provider.active, "convex");
    assert.equal(view.provider.convexDeployment, "dev:settings");
    assert.equal(view.provider.radiosDisabled, true);
    assert.equal(view.fallbackCta, null);
    assert.equal(view.backup.v4ExportEnabled, false);
    assert.match(view.backup.v4ExportRefusal, /export refused/i);
    assert.doesNotMatch(JSON.stringify(view), /try json instead|fall back to json/i);

    const action = await app.inject({
      method: "POST",
      url: "/api/v1/settings/persistence/actions",
      headers: { authorization: "Bearer current-secret" },
      payload: { action: "export-v4", file: "backups/nope.json" },
    });
    assert.equal(action.statusCode, 200);
    const body = action.json();
    assert.equal(body.status, "refused");
    assert.equal(body.code, "v4-export-refused");
    assert.doesNotMatch(body.detail, /current-secret/);
  });

  it("rejects a classic restore that omits the empty-target confirmation", async () => {
    process.env.PERSISTENCE_PROVIDER = "json";
    const app = await makeApp("json");
    const action = await app.inject({
      method: "POST",
      url: "/api/v1/settings/persistence/actions",
      headers: { authorization: "Bearer current-secret" },
      payload: { action: "restore-classic", file: "backups/jarvis.json" },
    });
    assert.equal(action.statusCode, 200);
    const body = action.json();
    assert.equal(body.code, "empty-target-required");
    assert.match(body.detail, /--confirm-empty-target/);
  });
});
