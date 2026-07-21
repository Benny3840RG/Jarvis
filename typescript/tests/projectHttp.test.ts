import assert from "node:assert/strict";
import { afterEach, describe, it } from "node:test";

import type { NestFastifyApplication } from "@nestjs/platform-fastify";

import { createJarvisHttpApp } from "../src/http/app.js";
import type { HttpAppConfig } from "../src/http/config.js";
import type { Project } from "../src/projects/project.js";
import type { PersistenceProvider } from "../src/persistence/persistence.js";

type InjectMethod = "GET" | "POST" | "PATCH" | "DELETE";

const CONFIG: HttpAppConfig = {
  version: "0.1.0",
  sourceVersion: "project-http-test",
  deploymentVersion: null,
  timezone: "Australia/Melbourne",
  currentToken: "current-secret",
  previousToken: undefined,
};

const AUTH = { authorization: "Bearer current-secret" };

function unusedPersistence(): PersistenceProvider {
  const forbidden = (): never => {
    throw new Error("persistence must not be reached in project HTTP tests");
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

describe("project HTTP boundary", () => {
  it("requires authentication", async () => {
    const app = await makeApp();
    assert.equal((await inject(app, "GET", "/api/v1/projects")).statusCode, 401);
  });

  it("creates, lists, gets, updates, and deletes a project", async () => {
    const app = await makeApp();

    const created = await inject(app, "POST", "/api/v1/projects", {
      headers: AUTH,
      payload: { clientId: "c1", title: "Deck rebuild", status: "active" },
    });
    assert.equal(created.statusCode, 201);
    const project = created.json<{ data: Project }>().data;
    assert.equal(project.title, "Deck rebuild");
    assert.equal(project.status, "active");
    assert.equal(project.clientId, "c1");

    assert.equal(
      (await inject(app, "GET", "/api/v1/projects", { headers: AUTH })).json<{ count: number }>()
        .count,
      1,
    );

    const updated = await inject(app, "PATCH", `/api/v1/projects/${project.id}`, {
      headers: AUTH,
      payload: { status: "done", notes: "handed over" },
    });
    assert.equal(updated.statusCode, 200);
    assert.equal(updated.json<{ data: Project }>().data.status, "done");

    assert.equal(
      (await inject(app, "DELETE", `/api/v1/projects/${project.id}`, { headers: AUTH })).statusCode,
      200,
    );
    assert.equal(
      (await inject(app, "GET", `/api/v1/projects/${project.id}`, { headers: AUTH })).statusCode,
      404,
    );
  });

  it("rejects a bad status, missing fields, and unknown id", async () => {
    const app = await makeApp();
    assert.equal(
      (
        await inject(app, "POST", "/api/v1/projects", {
          headers: AUTH,
          payload: { clientId: "c1", title: "X", status: "banana" },
        })
      ).statusCode,
      422,
    );
    assert.equal(
      (await inject(app, "POST", "/api/v1/projects", { headers: AUTH, payload: { title: "X" } }))
        .statusCode,
      422,
    );
    assert.equal(
      (await inject(app, "GET", "/api/v1/projects/nope", { headers: AUTH })).statusCode,
      404,
    );
  });
});
