import assert from "node:assert/strict";
import { afterEach, describe, it } from "node:test";

import type { NestFastifyApplication } from "@nestjs/platform-fastify";

import { createJarvisHttpApp } from "../src/http/app.js";
import type { HttpAppConfig } from "../src/http/config.js";
import type { Upgrade } from "../src/upgrades/upgrade.js";
import type { PersistenceProvider } from "../src/persistence/persistence.js";

type InjectMethod = "GET" | "POST" | "PATCH" | "DELETE";

const CONFIG: HttpAppConfig = {
  version: "0.1.0",
  sourceVersion: "upgrade-http-test",
  deploymentVersion: null,
  timezone: "Australia/Melbourne",
  currentToken: "current-secret",
  previousToken: undefined,
};

const AUTH = { authorization: "Bearer current-secret" };

function unusedPersistence(): PersistenceProvider {
  const forbidden = (): never => {
    throw new Error("persistence must not be reached in upgrade HTTP tests");
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

describe("upgrade HTTP boundary", () => {
  it("requires authentication", async () => {
    const app = await makeApp();
    assert.equal((await inject(app, "GET", "/api/v1/upgrades")).statusCode, 401);
  });

  it("creates, lists, gets, updates, and deletes an upgrade", async () => {
    const app = await makeApp();
    const when = Date.UTC(2026, 5, 1, 8, 0, 0);

    const created = await inject(app, "POST", "/api/v1/upgrades", {
      headers: AUTH,
      payload: {
        buildId: "b1",
        title: "Fitted a metal-gear servo",
        reason: "Plastic gears kept stripping.",
        beforeState: "Stock plastic-gear servo.",
        afterState: "25kg metal-gear servo.",
        parts: ["25kg servo", "servo mount", ""],
        version: "v3",
        occurredAt: when,
      },
    });
    assert.equal(created.statusCode, 201);
    const upgrade = created.json<{ data: Upgrade }>().data;
    assert.equal(upgrade.buildId, "b1");
    assert.equal(upgrade.title, "Fitted a metal-gear servo");
    assert.deepEqual(upgrade.parts, ["25kg servo", "servo mount"]);
    assert.equal(upgrade.version, "v3");
    assert.equal(upgrade.occurredAt, when);

    assert.equal(
      (await inject(app, "GET", "/api/v1/upgrades", { headers: AUTH })).json<{ count: number }>()
        .count,
      1,
    );

    const gotten = await inject(app, "GET", `/api/v1/upgrades/${upgrade.id}`, { headers: AUTH });
    assert.equal(gotten.statusCode, 200);
    assert.equal(gotten.json<{ data: Upgrade }>().data.id, upgrade.id);

    const updated = await inject(app, "PATCH", `/api/v1/upgrades/${upgrade.id}`, {
      headers: AUTH,
      payload: { outcome: "Held all day, no slop.", parts: null, occurredAt: null },
    });
    assert.equal(updated.statusCode, 200);
    const updatedUpgrade = updated.json<{ data: Upgrade }>().data;
    assert.equal(updatedUpgrade.outcome, "Held all day, no slop.");
    assert.equal(updatedUpgrade.parts, undefined);
    assert.equal(updatedUpgrade.occurredAt, undefined);

    assert.equal(
      (await inject(app, "DELETE", `/api/v1/upgrades/${upgrade.id}`, { headers: AUTH })).statusCode,
      200,
    );
    assert.equal(
      (await inject(app, "GET", `/api/v1/upgrades/${upgrade.id}`, { headers: AUTH })).statusCode,
      404,
    );
  });

  it("rejects unknown fields, non-array parts, non-numeric occurredAt, and missing fields", async () => {
    const app = await makeApp();
    assert.equal(
      (
        await inject(app, "POST", "/api/v1/upgrades", {
          headers: AUTH,
          payload: { buildId: "b1", title: "X", horsepower: 9000 },
        })
      ).statusCode,
      422,
    );
    assert.equal(
      (
        await inject(app, "POST", "/api/v1/upgrades", {
          headers: AUTH,
          payload: { buildId: "b1", title: "X", parts: "one servo" },
        })
      ).statusCode,
      422,
    );
    assert.equal(
      (
        await inject(app, "POST", "/api/v1/upgrades", {
          headers: AUTH,
          payload: { buildId: "b1", title: "X", occurredAt: "yesterday" },
        })
      ).statusCode,
      422,
    );
    assert.equal(
      (await inject(app, "POST", "/api/v1/upgrades", { headers: AUTH, payload: { title: "X" } }))
        .statusCode,
      422,
    );
    assert.equal(
      (await inject(app, "GET", "/api/v1/upgrades/nope", { headers: AUTH })).statusCode,
      404,
    );
    assert.equal(
      (await inject(app, "PATCH", "/api/v1/upgrades/nope", { headers: AUTH, payload: {} }))
        .statusCode,
      422,
    );
  });
});
