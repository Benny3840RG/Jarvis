import assert from "node:assert/strict";
import { afterEach, describe, it } from "node:test";

import type { NestFastifyApplication } from "@nestjs/platform-fastify";

import type { Asset, AssetStore } from "../src/assets/asset.js";
import { createJarvisHttpApp } from "../src/http/app.js";
import type { HttpAppConfig } from "../src/http/config.js";
import type { PersistenceProvider } from "../src/persistence/persistence.js";

const CONFIG: HttpAppConfig = {
  version: "0.1.0",
  sourceVersion: "operations-inbox-http-test",
  deploymentVersion: null,
  timezone: "Australia/Melbourne",
  currentToken: "current-secret",
};

const AUTH = { authorization: "Bearer current-secret" };
const openApps: NestFastifyApplication[] = [];

function forbiddenPersistence(overrides: Partial<PersistenceProvider> = {}): PersistenceProvider {
  const forbidden = (): never => {
    throw new Error("must not be reached");
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
    ...overrides,
  };
}

function forbiddenAssetStore(overrides: Partial<AssetStore> = {}): AssetStore {
  const forbidden = (): never => {
    throw new Error("must not be reached");
  };
  return {
    list: forbidden,
    get: forbidden,
    add: forbidden,
    update: forbidden,
    remove: forbidden,
    ...overrides,
  };
}

async function makeApp(
  persistence: PersistenceProvider,
  assetStore: AssetStore,
): Promise<NestFastifyApplication> {
  const app = await createJarvisHttpApp({
    persistence,
    assetStore,
    providerName: "json",
    config: CONFIG,
    logger: false,
  });
  openApps.push(app);
  return app;
}

afterEach(async () => {
  await Promise.all(openApps.splice(0).map((app) => app.close()));
});

describe("operations inbox HTTP boundary", () => {
  it("requires authentication", async () => {
    const app = await makeApp(forbiddenPersistence(), forbiddenAssetStore());
    const response = await app.inject({ method: "GET", url: "/api/v1/operations/inbox" });
    assert.equal(response.statusCode, 401);
  });

  it("returns items and per-source availability from the real stores", async () => {
    const now = Date.now();
    const overdueAsset: Asset = {
      id: "asset-1",
      name: "Bandsaw",
      kind: "tool",
      serviceIntervalDays: 30,
      lastServicedAt: now - 40 * 86_400_000,
      createdAt: now - 400 * 86_400_000,
      updatedAt: now - 40 * 86_400_000,
    };
    const app = await makeApp(
      forbiddenPersistence({ listReminders: async () => [] }),
      forbiddenAssetStore({ list: async () => [overdueAsset] }),
    );

    const response = await app.inject({
      method: "GET",
      url: "/api/v1/operations/inbox",
      headers: AUTH,
    });

    assert.equal(response.statusCode, 200);
    const body = response.json() as {
      data: { items: unknown[]; sources: { source: string; status: string }[] };
    };
    assert.equal(body.data.items.length, 1);
    const maintenance = body.data.sources.find((entry) => entry.source === "maintenance");
    assert.equal(maintenance?.status, "available");
  });

  it("degrades gracefully when one source fails, without failing the whole response", async () => {
    const app = await makeApp(
      forbiddenPersistence({
        listReminders: async () => {
          throw new Error("reminders store offline");
        },
      }),
      forbiddenAssetStore({ list: async () => [] }),
    );

    const response = await app.inject({
      method: "GET",
      url: "/api/v1/operations/inbox",
      headers: AUTH,
    });

    assert.equal(response.statusCode, 200);
    const body = response.json() as { data: { sources: { source: string; status: string }[] } };
    const reminders = body.data.sources.find((entry) => entry.source === "reminders");
    assert.equal(reminders?.status, "unavailable");
    const maintenance = body.data.sources.find((entry) => entry.source === "maintenance");
    assert.equal(maintenance?.status, "available");
  });

  it("reports not-yet-wired sources as unsupported in the HTTP response", async () => {
    const app = await makeApp(
      forbiddenPersistence({ listReminders: async () => [] }),
      forbiddenAssetStore({ list: async () => [] }),
    );

    const response = await app.inject({
      method: "GET",
      url: "/api/v1/operations/inbox",
      headers: AUTH,
    });

    const body = response.json() as { data: { sources: { source: string; status: string }[] } };
    for (const source of ["toolActions", "reconciliation", "quoteDelivery"]) {
      const report = body.data.sources.find((entry) => entry.source === source);
      assert.equal(report?.status, "unsupported");
    }
  });
});
