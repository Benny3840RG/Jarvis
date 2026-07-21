import assert from "node:assert/strict";
import { afterEach, describe, it } from "node:test";

import type { NestFastifyApplication } from "@nestjs/platform-fastify";

import { createJarvisHttpApp } from "../src/http/app.js";
import type { HttpAppConfig } from "../src/http/config.js";
import type { Errand } from "../src/errands/errand.js";
import type { PersistenceProvider } from "../src/persistence/persistence.js";

type InjectMethod = "GET" | "POST" | "PATCH" | "DELETE";

const CONFIG: HttpAppConfig = {
  version: "0.1.0",
  sourceVersion: "errand-http-test",
  deploymentVersion: null,
  timezone: "Australia/Melbourne",
  currentToken: "current-secret",
  previousToken: undefined,
};

const AUTH = { authorization: "Bearer current-secret" };

function unusedPersistence(): PersistenceProvider {
  const forbidden = (): never => {
    throw new Error("persistence must not be reached in errand HTTP tests");
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

describe("errand HTTP boundary", () => {
  it("requires authentication", async () => {
    const app = await makeApp();
    assert.equal((await inject(app, "GET", "/api/v1/errands")).statusCode, 401);
  });

  it("creates a located errand and completes it through PATCH", async () => {
    const app = await makeApp();

    const created = await inject(app, "POST", "/api/v1/errands", {
      headers: AUTH,
      payload: {
        title: "Silicone x2",
        quantity: 2,
        projectId: "p1",
        location: {
          label: "Bunnings Frankston",
          address: "111 Cranbourne Rd, Frankston VIC",
          lat: -38.1579,
          lon: 145.1509,
        },
      },
    });
    assert.equal(created.statusCode, 201);
    const errand = created.json<{ data: Errand }>().data;
    assert.equal(errand.status, "open");
    assert.equal(errand.quantity, 2);
    assert.equal(errand.location?.label, "Bunnings Frankston");
    assert.equal(errand.location?.lat, -38.1579);
    assert.equal(errand.completedAt, undefined);

    assert.equal(
      (await inject(app, "GET", "/api/v1/errands", { headers: AUTH })).json<{ count: number }>()
        .count,
      1,
    );

    const done = await inject(app, "PATCH", `/api/v1/errands/${errand.id}`, {
      headers: AUTH,
      payload: { status: "done" },
    });
    assert.equal(done.statusCode, 200);
    const doneErrand = done.json<{ data: Errand }>().data;
    assert.equal(doneErrand.status, "done");
    assert.ok((doneErrand.completedAt ?? 0) > 0);

    const cleared = await inject(app, "PATCH", `/api/v1/errands/${errand.id}`, {
      headers: AUTH,
      payload: { status: "open", location: null, quantity: null },
    });
    assert.equal(cleared.statusCode, 200);
    const clearedErrand = cleared.json<{ data: Errand }>().data;
    assert.equal(clearedErrand.status, "open");
    assert.equal(clearedErrand.completedAt, undefined);
    assert.equal(clearedErrand.location, undefined);
    assert.equal(clearedErrand.quantity, undefined);

    assert.equal(
      (await inject(app, "DELETE", `/api/v1/errands/${errand.id}`, { headers: AUTH })).statusCode,
      200,
    );
    assert.equal(
      (await inject(app, "GET", `/api/v1/errands/${errand.id}`, { headers: AUTH })).statusCode,
      404,
    );
  });

  it("rejects bad statuses, half-geocoded locations, and unknown fields", async () => {
    const app = await makeApp();
    assert.equal(
      (
        await inject(app, "POST", "/api/v1/errands", {
          headers: AUTH,
          payload: { title: "X", status: "someday" },
        })
      ).statusCode,
      422,
    );
    assert.equal(
      (
        await inject(app, "POST", "/api/v1/errands", {
          headers: AUTH,
          payload: { title: "X", location: { label: "Shop", lat: -38 } },
        })
      ).statusCode,
      422,
    );
    assert.equal(
      (
        await inject(app, "POST", "/api/v1/errands", {
          headers: AUTH,
          payload: { title: "X", location: { label: "Shop", lat: -95, lon: 145 } },
        })
      ).statusCode,
      422,
    );
    assert.equal(
      (
        await inject(app, "POST", "/api/v1/errands", {
          headers: AUTH,
          payload: { title: "X", location: { label: "Shop", geofence: true } },
        })
      ).statusCode,
      422,
    );
    assert.equal(
      (
        await inject(app, "POST", "/api/v1/errands", {
          headers: AUTH,
          payload: { title: "X", quantity: 0 },
        })
      ).statusCode,
      422,
    );
    assert.equal(
      (await inject(app, "POST", "/api/v1/errands", { headers: AUTH, payload: { notes: "X" } }))
        .statusCode,
      422,
    );
    assert.equal(
      (await inject(app, "GET", "/api/v1/errands/nope", { headers: AUTH })).statusCode,
      404,
    );
    assert.equal(
      (await inject(app, "PATCH", "/api/v1/errands/nope", { headers: AUTH, payload: {} }))
        .statusCode,
      422,
    );
  });
});
