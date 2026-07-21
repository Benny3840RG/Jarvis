import assert from "node:assert/strict";
import { afterEach, describe, it } from "node:test";

import type { NestFastifyApplication } from "@nestjs/platform-fastify";

import { createJarvisHttpApp } from "../src/http/app.js";
import type { HttpAppConfig } from "../src/http/config.js";
import type { BuildLogEntry } from "../src/buildLog/buildLogEntry.js";
import type { PersistenceProvider } from "../src/persistence/persistence.js";

type InjectMethod = "GET" | "POST" | "PATCH" | "DELETE";

const CONFIG: HttpAppConfig = {
  version: "0.1.0",
  sourceVersion: "build-log-http-test",
  deploymentVersion: null,
  timezone: "Australia/Melbourne",
  currentToken: "current-secret",
  previousToken: undefined,
};

const AUTH = { authorization: "Bearer current-secret" };

function unusedPersistence(): PersistenceProvider {
  const forbidden = (): never => {
    throw new Error("persistence must not be reached in build log HTTP tests");
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

describe("build log HTTP boundary", () => {
  it("requires authentication", async () => {
    const app = await makeApp();
    assert.equal((await inject(app, "GET", "/api/v1/build-logs")).statusCode, 401);
  });

  it("creates, lists, gets, updates, and deletes an entry", async () => {
    const app = await makeApp();
    const when = Date.UTC(2026, 3, 12, 9, 0, 0);

    const created = await inject(app, "POST", "/api/v1/build-logs", {
      headers: AUTH,
      payload: {
        buildId: "b1",
        kind: "milestone",
        title: "First clean crawl",
        body: "New servo held steering authority all the way up the ledge.",
        occurredAt: when,
      },
    });
    assert.equal(created.statusCode, 201);
    const entry = created.json<{ data: BuildLogEntry }>().data;
    assert.equal(entry.buildId, "b1");
    assert.equal(entry.kind, "milestone");
    assert.equal(entry.title, "First clean crawl");
    assert.equal(entry.occurredAt, when);

    assert.equal(
      (await inject(app, "GET", "/api/v1/build-logs", { headers: AUTH })).json<{ count: number }>()
        .count,
      1,
    );

    const gotten = await inject(app, "GET", `/api/v1/build-logs/${entry.id}`, { headers: AUTH });
    assert.equal(gotten.statusCode, 200);
    assert.equal(gotten.json<{ data: BuildLogEntry }>().data.id, entry.id);

    const updated = await inject(app, "PATCH", `/api/v1/build-logs/${entry.id}`, {
      headers: AUTH,
      payload: { kind: "note", occurredAt: null },
    });
    assert.equal(updated.statusCode, 200);
    const updatedEntry = updated.json<{ data: BuildLogEntry }>().data;
    assert.equal(updatedEntry.kind, "note");
    assert.equal(updatedEntry.occurredAt, undefined);

    assert.equal(
      (await inject(app, "DELETE", `/api/v1/build-logs/${entry.id}`, { headers: AUTH })).statusCode,
      200,
    );
    assert.equal(
      (await inject(app, "GET", `/api/v1/build-logs/${entry.id}`, { headers: AUTH })).statusCode,
      404,
    );
  });

  it("defaults kind to note and trims text", async () => {
    const app = await makeApp();
    const created = await inject(app, "POST", "/api/v1/build-logs", {
      headers: AUTH,
      payload: { buildId: "b1", title: "  Bought it home  " },
    });
    assert.equal(created.statusCode, 201);
    const entry = created.json<{ data: BuildLogEntry }>().data;
    assert.equal(entry.kind, "note");
    assert.equal(entry.title, "Bought it home");
  });

  it("rejects a bad kind, unknown fields, non-numeric occurredAt, and missing fields", async () => {
    const app = await makeApp();
    assert.equal(
      (
        await inject(app, "POST", "/api/v1/build-logs", {
          headers: AUTH,
          payload: { buildId: "b1", title: "X", kind: "legend" },
        })
      ).statusCode,
      422,
    );
    assert.equal(
      (
        await inject(app, "POST", "/api/v1/build-logs", {
          headers: AUTH,
          payload: { buildId: "b1", title: "X", horsepower: 9000 },
        })
      ).statusCode,
      422,
    );
    assert.equal(
      (
        await inject(app, "POST", "/api/v1/build-logs", {
          headers: AUTH,
          payload: { buildId: "b1", title: "X", occurredAt: "yesterday" },
        })
      ).statusCode,
      422,
    );
    assert.equal(
      (await inject(app, "POST", "/api/v1/build-logs", { headers: AUTH, payload: { title: "X" } }))
        .statusCode,
      422,
    );
    assert.equal(
      (await inject(app, "GET", "/api/v1/build-logs/nope", { headers: AUTH })).statusCode,
      404,
    );
    assert.equal(
      (await inject(app, "PATCH", "/api/v1/build-logs/nope", { headers: AUTH, payload: {} }))
        .statusCode,
      422,
    );
  });
});
