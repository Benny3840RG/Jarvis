import assert from "node:assert/strict";
import { afterEach, describe, it } from "node:test";

import type { NestFastifyApplication } from "@nestjs/platform-fastify";

import { createJarvisHttpApp } from "../src/http/app.js";
import type { HttpAppConfig } from "../src/http/config.js";
import type { Property } from "../src/properties/property.js";
import type { PersistenceProvider } from "../src/persistence/persistence.js";

type InjectMethod = "GET" | "POST" | "PATCH" | "DELETE";

const CONFIG: HttpAppConfig = {
  version: "0.1.0",
  sourceVersion: "property-http-test",
  deploymentVersion: null,
  timezone: "Australia/Melbourne",
  currentToken: "current-secret",
  previousToken: undefined,
};

const AUTH = { authorization: "Bearer current-secret" };

function unusedPersistence(): PersistenceProvider {
  const forbidden = (): never => {
    throw new Error("persistence must not be reached in property HTTP tests");
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

describe("property HTTP boundary", () => {
  it("requires authentication", async () => {
    const app = await makeApp();
    assert.equal((await inject(app, "GET", "/api/v1/properties")).statusCode, 401);
  });

  it("creates, lists, filters, gets, updates, and deletes a property", async () => {
    const app = await makeApp();

    const created = await inject(app, "POST", "/api/v1/properties", {
      headers: AUTH,
      payload: {
        clientId: "client-1",
        address: "12 Gum Street, Preston VIC 3072",
        hazards: ["dog on site", "narrow driveway"],
      },
    });
    assert.equal(created.statusCode, 201);
    const property = created.json<{ data: Property }>().data;
    assert.equal(property.clientId, "client-1");
    assert.deepEqual(property.hazards, ["dog on site", "narrow driveway"]);

    await inject(app, "POST", "/api/v1/properties", {
      headers: AUTH,
      payload: { clientId: "client-2", address: "99 Other Road" },
    });

    const list = await inject(app, "GET", "/api/v1/properties", { headers: AUTH });
    assert.equal(list.statusCode, 200);
    assert.equal(list.json<{ count: number }>().count, 2);

    const filtered = await inject(app, "GET", "/api/v1/properties?clientId=client-1", {
      headers: AUTH,
    });
    assert.equal(filtered.statusCode, 200);
    assert.equal(filtered.json<{ count: number }>().count, 1);

    const fetched = await inject(app, "GET", `/api/v1/properties/${property.id}`, {
      headers: AUTH,
    });
    assert.equal(fetched.statusCode, 200);

    const updated = await inject(app, "PATCH", `/api/v1/properties/${property.id}`, {
      headers: AUTH,
      payload: { accessNotes: "Use side gate" },
    });
    assert.equal(updated.statusCode, 200);
    assert.equal(updated.json<{ data: Property }>().data.accessNotes, "Use side gate");

    assert.equal(
      (await inject(app, "DELETE", `/api/v1/properties/${property.id}`, { headers: AUTH }))
        .statusCode,
      200,
    );
    assert.equal(
      (await inject(app, "GET", `/api/v1/properties/${property.id}`, { headers: AUTH })).statusCode,
      404,
    );
  });

  it("rejects invalid bodies and unknown ids", async () => {
    const app = await makeApp();
    assert.equal(
      (await inject(app, "POST", "/api/v1/properties", { headers: AUTH, payload: {} })).statusCode,
      422,
    );
    assert.equal(
      (
        await inject(app, "POST", "/api/v1/properties", {
          headers: AUTH,
          payload: { clientId: "client-1", address: "X", hazard: ["unsupported"] },
        })
      ).statusCode,
      422,
    );
    assert.equal(
      (await inject(app, "GET", "/api/v1/properties/nope", { headers: AUTH })).statusCode,
      404,
    );
    assert.equal(
      (await inject(app, "PATCH", "/api/v1/properties/nope", { headers: AUTH, payload: {} }))
        .statusCode,
      422,
    );
  });
});
