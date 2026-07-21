import assert from "node:assert/strict";
import { afterEach, describe, it } from "node:test";

import type { NestFastifyApplication } from "@nestjs/platform-fastify";

import { createJarvisHttpApp } from "../src/http/app.js";
import type { HttpAppConfig } from "../src/http/config.js";
import type { AssetView } from "../src/assets/assetView.js";
import type { PersistenceProvider } from "../src/persistence/persistence.js";

type InjectMethod = "GET" | "POST" | "PATCH" | "DELETE";

const CONFIG: HttpAppConfig = {
  version: "0.1.0",
  sourceVersion: "asset-http-test",
  deploymentVersion: null,
  timezone: "Australia/Melbourne",
  currentToken: "current-secret",
  previousToken: undefined,
};

const AUTH = { authorization: "Bearer current-secret" };
const MS_PER_DAY = 86_400_000;

function unusedPersistence(): PersistenceProvider {
  const forbidden = (): never => {
    throw new Error("persistence must not be reached in asset HTTP tests");
  };
  return {
    loadState: forbidden,
    saveState: forbidden,
    listTasks: forbidden,
    addTask: forbidden,
    updateTask: forbidden,
    completeTask: forbidden,
    removeTask: forbidden,
    listReminders: forbidden,
    addReminder: forbidden,
    updateReminder: forbidden,
    removeReminder: forbidden,
  };
}

const openApps: NestFastifyApplication[] = [];

async function makeApp(): Promise<NestFastifyApplication> {
  const app = await createJarvisHttpApp({
    persistence: unusedPersistence(),
    providerName: "json",
    config: CONFIG,
    logger: false,
  });
  openApps.push(app);
  return app;
}

function inject(
  app: NestFastifyApplication,
  method: InjectMethod,
  url: string,
  options: { headers?: Record<string, string>; payload?: object } = {},
) {
  return app.inject({
    method,
    url,
    headers: { ...(options.headers ?? {}) },
    ...(options.payload === undefined ? {} : { payload: options.payload }),
  });
}

afterEach(async () => {
  await Promise.all(openApps.splice(0).map((app) => app.close()));
});

describe("asset HTTP boundary", () => {
  it("requires authentication", async () => {
    const app = await makeApp();
    assert.equal((await inject(app, "GET", "/api/v1/assets")).statusCode, 401);
  });

  it("creates, lists, gets, updates, and deletes an asset", async () => {
    const app = await makeApp();

    const created = await inject(app, "POST", "/api/v1/assets", {
      headers: AUTH,
      payload: { name: "Ride-on mower", kind: "machine", notes: "Grease the deck." },
    });
    assert.equal(created.statusCode, 201);
    const asset = created.json<{ data: AssetView }>().data;
    assert.equal(asset.name, "Ride-on mower");
    assert.equal(asset.due, false);
    assert.equal(asset.nextDueAt, undefined);

    assert.equal(
      (await inject(app, "GET", "/api/v1/assets", { headers: AUTH })).json<{ count: number }>()
        .count,
      1,
    );

    const gotten = await inject(app, "GET", `/api/v1/assets/${asset.id}`, { headers: AUTH });
    assert.equal(gotten.statusCode, 200);
    assert.equal(gotten.json<{ data: AssetView }>().data.id, asset.id);

    const updated = await inject(app, "PATCH", `/api/v1/assets/${asset.id}`, {
      headers: AUTH,
      payload: { notes: null },
    });
    assert.equal(updated.statusCode, 200);
    assert.equal(updated.json<{ data: AssetView }>().data.notes, undefined);

    assert.equal(
      (await inject(app, "DELETE", `/api/v1/assets/${asset.id}`, { headers: AUTH })).statusCode,
      200,
    );
    assert.equal(
      (await inject(app, "GET", `/api/v1/assets/${asset.id}`, { headers: AUTH })).statusCode,
      404,
    );
  });

  it("derives due=true for an overdue asset", async () => {
    const app = await makeApp();
    const created = await inject(app, "POST", "/api/v1/assets", {
      headers: AUTH,
      payload: {
        name: "Chainsaw",
        kind: "tool",
        serviceIntervalDays: 1,
        lastServicedAt: Date.now() - 10 * MS_PER_DAY,
      },
    });
    assert.equal(created.statusCode, 201);
    const asset = created.json<{ data: AssetView }>().data;
    assert.equal(asset.due, true);
    assert.ok(typeof asset.nextDueAt === "number");
  });

  it("derives due=false for an asset serviced within its interval", async () => {
    const app = await makeApp();
    const created = await inject(app, "POST", "/api/v1/assets", {
      headers: AUTH,
      payload: {
        name: "Compressor",
        kind: "machine",
        serviceIntervalDays: 3650,
        lastServicedAt: Date.now(),
      },
    });
    assert.equal(created.statusCode, 201);
    const asset = created.json<{ data: AssetView }>().data;
    assert.equal(asset.due, false);
    assert.ok(typeof asset.nextDueAt === "number");
  });

  it("rejects unknown fields, a non-positive interval, bad timestamp, and missing fields", async () => {
    const app = await makeApp();
    assert.equal(
      (
        await inject(app, "POST", "/api/v1/assets", {
          headers: AUTH,
          payload: { name: "X", kind: "tool", horsepower: 9000 },
        })
      ).statusCode,
      422,
    );
    assert.equal(
      (
        await inject(app, "POST", "/api/v1/assets", {
          headers: AUTH,
          payload: { name: "X", kind: "tool", serviceIntervalDays: 0 },
        })
      ).statusCode,
      422,
    );
    assert.equal(
      (
        await inject(app, "POST", "/api/v1/assets", {
          headers: AUTH,
          payload: { name: "X", kind: "tool", lastServicedAt: "today" },
        })
      ).statusCode,
      422,
    );
    assert.equal(
      (await inject(app, "POST", "/api/v1/assets", { headers: AUTH, payload: { name: "X" } }))
        .statusCode,
      422,
    );
    assert.equal(
      (await inject(app, "GET", "/api/v1/assets/nope", { headers: AUTH })).statusCode,
      404,
    );
    assert.equal(
      (await inject(app, "PATCH", "/api/v1/assets/nope", { headers: AUTH, payload: {} }))
        .statusCode,
      422,
    );
  });
});
