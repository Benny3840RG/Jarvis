import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { afterEach, describe, it } from "node:test";

import type { NestFastifyApplication } from "@nestjs/platform-fastify";
import Ajv2020 from "ajv/dist/2020.js";

import type { ToolAction, ToolActionService } from "../src/actions/toolActions.js";
import { createJarvisHttpApp } from "../src/http/app.js";
import type { HttpAppConfig } from "../src/http/config.js";
import type { PersistenceProvider } from "../src/persistence/persistence.js";
import { InMemoryProjectStore } from "../src/projects/inMemoryProjectStore.js";
import { captureCredentials } from "../src/settings/credentialsStatus.js";
import { composeSituationSnapshot } from "../src/situation/situationSnapshot.js";

const TOKEN = "situation-service-token";
const openApps: NestFastifyApplication[] = [];
afterEach(async () => {
  while (openApps.length > 0) await openApps.pop()?.close();
});

function persistence(): PersistenceProvider {
  const forbidden = (): never => {
    throw new Error("the situation snapshot must not write");
  };
  return {
    loadState: async () => ({}) as never,
    saveState: forbidden,
    listTasks: async () => [
      {
        id: "t1",
        title: "Quote the Smith fence",
        completed: false,
        category: "work",
        createdAt: 1,
      },
    ],
    addTask: forbidden,
    updateTask: forbidden,
    completeTask: forbidden,
    removeTask: forbidden,
    listReminders: async () => [],
    addReminder: forbidden,
    updateReminder: forbidden,
    removeReminder: forbidden,
  };
}

const writes: string[] = [];
const refuse = (name: string) => async (): Promise<ToolAction> => {
  writes.push(name);
  throw new Error(`${name} must not be called`);
};
const toolActions: ToolActionService = {
  stage: refuse("stage"),
  get: async () => null,
  list: async () => [],
  approve: refuse("approve"),
  reject: refuse("reject"),
  countProposed: async () => ({ count: 3, capped: false }),
};

async function open(host = "127.0.0.1") {
  const config: HttpAppConfig = {
    version: "0.1.0",
    sourceVersion: "situation-test",
    deploymentVersion: null,
    timezone: "Australia/Melbourne",
    currentToken: TOKEN,
    previousToken: undefined,
  };
  const app = await createJarvisHttpApp({
    config,
    credentialsRuntime: captureCredentials({
      serviceToken: TOKEN,
      httpHost: host,
      httpPort: 3000,
      mcpHost: "127.0.0.1",
      mcpPort: 8787,
      remoteGatewayEnabled: false,
      tlsTerminated: false,
      oidcConfigured: false,
      originsConfigured: false,
      persistenceProvider: "json",
    }),
    persistence: persistence(),
    providerName: "json",
    logger: false,
    projectStore: new InMemoryProjectStore(),
    toolActionService: toolActions,
  });
  openApps.push(app);
  return app;
}

function validator() {
  const document = JSON.parse(
    readFileSync(new URL("../openapi/jarvis.openapi.json", import.meta.url), "utf8"),
  );
  return new Ajv2020.default({ strict: false }).compile({
    ...document.components.schemas.SituationSnapshot,
    components: document.components,
  });
}

describe("GET /api/v1/situation", () => {
  it("needs the service token, even on loopback", async () => {
    const app = await open();
    const anonymous = await app.inject({ method: "GET", url: "/api/v1/situation" });
    assert.equal(anonymous.statusCode, 401);
  });

  it("returns a read-only snapshot that matches the OpenAPI contract", async () => {
    const app = await open();
    const response = await app.inject({
      method: "GET",
      url: "/api/v1/situation",
      headers: { authorization: `Bearer ${TOKEN}` },
    });
    assert.equal(response.statusCode, 200);
    assert.equal(response.headers["cache-control"], "no-store");
    const body = response.json();
    const validate = validator();
    assert.equal(validate(body), true, JSON.stringify(validate.errors));
    assert.equal(body.timezone, "Australia/Melbourne");
    assert.deepEqual(body.fields.openTasks.value, { count: 1, titles: ["Quote the Smith fence"] });
    assert.deepEqual(body.fields.pendingApprovals.value, { count: 3, capped: false });
    assert.equal(body.fields.devices.status, "unknown");
    assert.deepEqual(writes, [], "no ToolAction was staged, approved or rejected");
    assert.equal(response.body.includes(TOKEN), false);
  });
});

describe("SituationSnapshot OpenAPI contract", () => {
  it("accepts snapshots in every source state and rejects impossible fields", async () => {
    const validate = validator();
    const boom = async (): Promise<never> => {
      throw new Error("down");
    };
    const now = Date.UTC(2026, 10, 17, 0, 42, 5);
    for (const snapshot of [
      await composeSituationSnapshot({
        now: () => now,
        timezone: "Australia/Melbourne",
        status: null,
        tasks: null,
        reminders: null,
        projects: null,
        approvals: null,
        reconciliation: null,
      }),
      await composeSituationSnapshot({
        now: () => now,
        timezone: "Not/AZone",
        status: { inspect: boom },
        tasks: { listTasks: boom },
        reminders: { listReminders: boom },
        projects: { list: boom },
        approvals: { countProposed: boom },
        reconciliation: () =>
          ({
            state: "running",
            enabled: true,
            freshnessMs: 60_000,
            lastSuccessfulCycleAt: new Date(now - 3_600_000).toISOString(),
            lastCycleOutcome: "failed",
          }) as never,
      }),
    ]) {
      assert.equal(validate(snapshot), true, JSON.stringify(validate.errors));
    }
    const base = await composeSituationSnapshot({
      now: () => now,
      timezone: "Australia/Melbourne",
      status: null,
      tasks: null,
      reminders: null,
      projects: null,
      approvals: null,
      reconciliation: null,
    });
    const withField = (key: string, field: unknown) => ({
      ...base,
      fields: { ...base.fields, [key]: field },
    });
    for (const bad of [
      withField("calendar", { ...base.fields.calendar, value: {} }),
      withField("presence", { ...base.fields.presence, freshness: "live" }),
      withField("openTasks", { ...base.fields.openTasks, status: "available" }),
      withField("devices", { ...base.fields.devices, observedAt: new Date(now).toISOString() }),
      { ...base, fields: { ...base.fields, extra: base.fields.calendar } },
    ]) {
      assert.equal(validate(bad), false, JSON.stringify(bad).slice(0, 200));
    }
  });
});
