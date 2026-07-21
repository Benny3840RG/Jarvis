import assert from "node:assert/strict";
import { afterEach, describe, it } from "node:test";

import type { NestFastifyApplication } from "@nestjs/platform-fastify";

import { createJarvisHttpApp } from "../src/http/app.js";
import type { HttpAppConfig } from "../src/http/config.js";
import type { Build } from "../src/builds/build.js";
import type { PersistenceProvider } from "../src/persistence/persistence.js";

type InjectMethod = "GET" | "POST" | "PATCH" | "DELETE";

const CONFIG: HttpAppConfig = {
  version: "0.1.0",
  sourceVersion: "build-http-test",
  deploymentVersion: null,
  timezone: "Australia/Melbourne",
  currentToken: "current-secret",
  previousToken: undefined,
};

const AUTH = { authorization: "Bearer current-secret" };

function unusedPersistence(): PersistenceProvider {
  const forbidden = (): never => {
    throw new Error("persistence must not be reached in build HTTP tests");
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

describe("build HTTP boundary", () => {
  it("requires authentication", async () => {
    const app = await makeApp();
    assert.equal((await inject(app, "GET", "/api/v1/builds")).statusCode, 401);
  });

  it("creates, lists, gets, updates, and deletes a build", async () => {
    const app = await makeApp();

    const created = await inject(app, "POST", "/api/v1/builds", {
      headers: AUTH,
      payload: { name: "Rock crawler", kind: "RC crawler", nickname: "The Goat" },
    });
    assert.equal(created.statusCode, 201);
    const build = created.json<{ data: Build }>().data;
    assert.equal(build.name, "Rock crawler");
    assert.equal(build.kind, "RC crawler");
    assert.equal(build.status, "planning");
    assert.equal(build.nickname, "The Goat");

    assert.equal(
      (await inject(app, "GET", "/api/v1/builds", { headers: AUTH })).json<{ count: number }>()
        .count,
      1,
    );

    const gotten = await inject(app, "GET", `/api/v1/builds/${build.id}`, { headers: AUTH });
    assert.equal(gotten.statusCode, 200);
    assert.equal(gotten.json<{ data: Build }>().data.id, build.id);

    const updated = await inject(app, "PATCH", `/api/v1/builds/${build.id}`, {
      headers: AUTH,
      payload: { status: "active", nickname: null },
    });
    assert.equal(updated.statusCode, 200);
    const updatedBuild = updated.json<{ data: Build }>().data;
    assert.equal(updatedBuild.status, "active");
    assert.equal(updatedBuild.nickname, undefined);

    assert.equal(
      (await inject(app, "DELETE", `/api/v1/builds/${build.id}`, { headers: AUTH })).statusCode,
      200,
    );
    assert.equal(
      (await inject(app, "GET", `/api/v1/builds/${build.id}`, { headers: AUTH })).statusCode,
      404,
    );
  });

  it("rejects a bad status, unknown fields, and missing required fields", async () => {
    const app = await makeApp();
    assert.equal(
      (
        await inject(app, "POST", "/api/v1/builds", {
          headers: AUTH,
          payload: { name: "X", kind: "tool", status: "someday" },
        })
      ).statusCode,
      422,
    );
    assert.equal(
      (
        await inject(app, "POST", "/api/v1/builds", {
          headers: AUTH,
          payload: { name: "X", kind: "tool", horsepower: 9000 },
        })
      ).statusCode,
      422,
    );
    assert.equal(
      (await inject(app, "POST", "/api/v1/builds", { headers: AUTH, payload: { name: "X" } }))
        .statusCode,
      422,
    );
    assert.equal(
      (await inject(app, "GET", "/api/v1/builds/nope", { headers: AUTH })).statusCode,
      404,
    );
    assert.equal(
      (await inject(app, "PATCH", "/api/v1/builds/nope", { headers: AUTH, payload: {} }))
        .statusCode,
      422,
    );
  });
});
