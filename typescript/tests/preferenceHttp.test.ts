import assert from "node:assert/strict";
import { afterEach, describe, it } from "node:test";

import type { NestFastifyApplication } from "@nestjs/platform-fastify";

import { createJarvisHttpApp } from "../src/http/app.js";
import type { HttpAppConfig } from "../src/http/config.js";
import type { Preference } from "../src/preferences/preference.js";
import type { PersistenceProvider } from "../src/persistence/persistence.js";

type InjectMethod = "GET" | "POST" | "PATCH" | "DELETE";

const CONFIG: HttpAppConfig = {
  version: "0.1.0",
  sourceVersion: "preference-http-test",
  deploymentVersion: null,
  timezone: "Australia/Melbourne",
  currentToken: "current-secret",
  previousToken: undefined,
};

const AUTH = { authorization: "Bearer current-secret" };

function unusedPersistence(): PersistenceProvider {
  const forbidden = (): never => {
    throw new Error("persistence must not be reached in preference HTTP tests");
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

describe("preference HTTP boundary", () => {
  it("requires authentication", async () => {
    const app = await makeApp();
    assert.equal((await inject(app, "GET", "/api/v1/preferences")).statusCode, 401);
  });

  it("creates, lists, gets, updates, and deletes a preference", async () => {
    const app = await makeApp();

    const created = await inject(app, "POST", "/api/v1/preferences", {
      headers: AUTH,
      payload: { key: "paint brand", value: "Dulux", category: "paint" },
    });
    assert.equal(created.statusCode, 201);
    const pref = created.json<{ data: Preference }>().data;
    assert.equal(pref.key, "paint brand");
    assert.equal(pref.value, "Dulux");
    assert.equal(pref.category, "paint");

    assert.equal(
      (await inject(app, "GET", "/api/v1/preferences", { headers: AUTH })).json<{ count: number }>()
        .count,
      1,
    );

    const gotten = await inject(app, "GET", `/api/v1/preferences/${pref.id}`, { headers: AUTH });
    assert.equal(gotten.statusCode, 200);
    assert.equal(gotten.json<{ data: Preference }>().data.id, pref.id);

    const updated = await inject(app, "PATCH", `/api/v1/preferences/${pref.id}`, {
      headers: AUTH,
      payload: { value: "Taubmans", category: null },
    });
    assert.equal(updated.statusCode, 200);
    const updatedPref = updated.json<{ data: Preference }>().data;
    assert.equal(updatedPref.value, "Taubmans");
    assert.equal(updatedPref.category, undefined);

    assert.equal(
      (await inject(app, "DELETE", `/api/v1/preferences/${pref.id}`, { headers: AUTH })).statusCode,
      200,
    );
    assert.equal(
      (await inject(app, "GET", `/api/v1/preferences/${pref.id}`, { headers: AUTH })).statusCode,
      404,
    );
  });

  it("rejects unknown fields, a blank key or value, and missing required fields", async () => {
    const app = await makeApp();
    assert.equal(
      (
        await inject(app, "POST", "/api/v1/preferences", {
          headers: AUTH,
          payload: { key: "k", value: "v", scope: "global" },
        })
      ).statusCode,
      422,
    );
    assert.equal(
      (
        await inject(app, "POST", "/api/v1/preferences", {
          headers: AUTH,
          payload: { key: " ", value: "v" },
        })
      ).statusCode,
      422,
    );
    assert.equal(
      (
        await inject(app, "POST", "/api/v1/preferences", {
          headers: AUTH,
          payload: { key: "k", value: " " },
        })
      ).statusCode,
      422,
    );
    assert.equal(
      (await inject(app, "POST", "/api/v1/preferences", { headers: AUTH, payload: { key: "k" } }))
        .statusCode,
      422,
    );
    assert.equal(
      (await inject(app, "GET", "/api/v1/preferences/nope", { headers: AUTH })).statusCode,
      404,
    );
    assert.equal(
      (await inject(app, "PATCH", "/api/v1/preferences/nope", { headers: AUTH, payload: {} }))
        .statusCode,
      422,
    );
  });
});
