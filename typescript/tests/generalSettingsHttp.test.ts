import assert from "node:assert/strict";
import { afterEach, describe, it } from "node:test";

import type { NestFastifyApplication } from "@nestjs/platform-fastify";

import { createJarvisHttpApp } from "../src/http/app.js";
import type { HttpAppConfig } from "../src/http/config.js";
import type { PersistenceProvider } from "../src/persistence/persistence.js";
import { inspectReminderTimezone, type OperatorGeneralSettings } from "../src/reminders/due.js";

const BASE_CONFIG: HttpAppConfig = {
  version: "0.1.0",
  sourceVersion: "test-source-0001",
  deploymentVersion: null,
  timezone: "Pacific/Auckland",
  currentToken: "current-secret",
  previousToken: "previous-secret",
};

const openApps: NestFastifyApplication[] = [];

function makePersistence(reads: { count: number }): PersistenceProvider {
  return {
    async loadState() {
      reads.count += 1;
      return {};
    },
    async saveState() {
      reads.count += 1;
    },
    async listTasks() {
      reads.count += 1;
      return [];
    },
    async addTask() {
      throw new Error("not used");
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
      reads.count += 1;
      return [];
    },
    async addReminder() {
      throw new Error("not used");
    },
    async updateReminder() {
      return null;
    },
    async removeReminder() {
      return null;
    },
  };
}

async function makeApp(config: Partial<HttpAppConfig>, reads: { count: number }) {
  const app = await createJarvisHttpApp({
    persistence: makePersistence(reads),
    providerName: "json",
    config: { ...BASE_CONFIG, ...config },
    logger: false,
  });
  openApps.push(app);
  return app;
}

afterEach(async () => {
  await Promise.all(openApps.splice(0).map((app) => app.close()));
});

describe("GET /api/v1/settings/general", () => {
  it("requires the operator token", async () => {
    const app = await makeApp({}, { count: 0 });
    const response = await app.inject({ method: "GET", url: "/api/v1/settings/general" });
    assert.equal(response.statusCode, 401);
  });

  it("returns the env timezone used by reminder normalization", async () => {
    const reads = { count: 0 };
    const app = await makeApp({ timezone: "Pacific/Auckland" }, reads);
    const response = await app.inject({
      method: "GET",
      url: "/api/v1/settings/general",
      headers: { authorization: "Bearer current-secret" },
    });
    const body = response.json<OperatorGeneralSettings>();

    assert.equal(response.statusCode, 200);
    assert.deepEqual(body, { timezone: inspectReminderTimezone("Pacific/Auckland") });
    assert.equal(body.timezone.source, "env");
    assert.equal(body.timezone.effectiveIana, "Pacific/Auckland");
    assert.equal(reads.count, 0);
    assert.equal(JSON.stringify(body).includes("email"), false);
  });

  it("reports an invalid timezone without applying the machine zone or reading persistence", async () => {
    const reads = { count: 0 };
    const app = await makeApp({ timezone: "Not/A-Timezone" }, reads);
    const response = await app.inject({
      method: "GET",
      url: "/api/v1/settings/general",
      headers: { authorization: "Bearer current-secret" },
    });
    const body = response.json<OperatorGeneralSettings>();

    assert.equal(response.statusCode, 200);
    assert.equal(body.timezone.valid, false);
    assert.equal(body.timezone.source, "env");
    assert.equal(body.timezone.envRaw, "Not/A-Timezone");
    assert.equal(body.timezone.effectiveIana, null);
    assert.notEqual(body.timezone.machineIana, "Not/A-Timezone");
    assert.equal(reads.count, 0);
  });

  it("reports the machine zone when no timezone is configured", async () => {
    const app = await makeApp({ timezone: "" }, { count: 0 });
    const response = await app.inject({
      method: "GET",
      url: "/api/v1/settings/general",
      headers: { authorization: "Bearer current-secret" },
    });
    const body = response.json<OperatorGeneralSettings>();

    assert.equal(response.statusCode, 200);
    assert.deepEqual(body.timezone, inspectReminderTimezone(""));
    assert.equal(body.timezone.source, "machine");
    assert.equal(body.timezone.envRaw, null);
  });
});
