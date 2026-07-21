import assert from "node:assert/strict";
import { afterEach, describe, it } from "node:test";

import type { NestFastifyApplication } from "@nestjs/platform-fastify";

import { createJarvisHttpApp } from "../src/http/app.js";
import type { HttpAppConfig } from "../src/http/config.js";
import type { Client } from "../src/clients/client.js";
import type { PersistenceProvider } from "../src/persistence/persistence.js";

type InjectMethod = "GET" | "POST" | "PATCH" | "DELETE";

const CONFIG: HttpAppConfig = {
  version: "0.1.0",
  sourceVersion: "client-http-test",
  deploymentVersion: null,
  timezone: "Australia/Melbourne",
  currentToken: "current-secret",
  previousToken: undefined,
};

const AUTH = { authorization: "Bearer current-secret" };

function unusedPersistence(): PersistenceProvider {
  const forbidden = (): never => {
    throw new Error("persistence must not be reached in client HTTP tests");
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

describe("client HTTP boundary", () => {
  it("requires authentication", async () => {
    const app = await makeApp();
    assert.equal((await inject(app, "GET", "/api/v1/clients")).statusCode, 401);
  });

  it("creates, lists, gets, updates, and deletes a client", async () => {
    const app = await makeApp();

    const created = await inject(app, "POST", "/api/v1/clients", {
      headers: AUTH,
      payload: { name: "Acme Joinery", contacts: [{ label: "mobile", value: "0400 000 000" }] },
    });
    assert.equal(created.statusCode, 201);
    const client = created.json<{ data: Client }>().data;
    assert.equal(client.name, "Acme Joinery");
    assert.equal(client.contacts[0].value, "0400 000 000");

    const list = await inject(app, "GET", "/api/v1/clients", { headers: AUTH });
    assert.equal(list.statusCode, 200);
    assert.equal(list.json<{ count: number }>().count, 1);

    const fetched = await inject(app, "GET", `/api/v1/clients/${client.id}`, { headers: AUTH });
    assert.equal(fetched.statusCode, 200);

    const updated = await inject(app, "PATCH", `/api/v1/clients/${client.id}`, {
      headers: AUTH,
      payload: { notes: "Prefers email" },
    });
    assert.equal(updated.statusCode, 200);
    assert.equal(updated.json<{ data: Client }>().data.notes, "Prefers email");

    const removed = await inject(app, "DELETE", `/api/v1/clients/${client.id}`, { headers: AUTH });
    assert.equal(removed.statusCode, 200);
    assert.equal(
      (await inject(app, "GET", `/api/v1/clients/${client.id}`, { headers: AUTH })).statusCode,
      404,
    );
  });

  it("rejects an invalid create body and an unknown id", async () => {
    const app = await makeApp();
    assert.equal(
      (await inject(app, "POST", "/api/v1/clients", { headers: AUTH, payload: {} })).statusCode,
      422,
    );
    assert.equal(
      (await inject(app, "GET", "/api/v1/clients/nope", { headers: AUTH })).statusCode,
      404,
    );
    assert.equal(
      (await inject(app, "PATCH", "/api/v1/clients/x", { headers: AUTH, payload: {} })).statusCode,
      422,
    );
  });
});
