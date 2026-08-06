import assert from "node:assert/strict";
import { afterEach, describe, it } from "node:test";

import type { NestFastifyApplication } from "@nestjs/platform-fastify";

import { createJarvisHttpApp } from "../src/http/app.js";
import type { HttpAppConfig } from "../src/http/config.js";
import type { ActivityEventReader } from "../src/operations/activityTimeline.js";
import type { PersistenceProvider } from "../src/persistence/persistence.js";

const CONFIG: HttpAppConfig = {
  version: "0.1.0",
  sourceVersion: "activity-timeline-http-test",
  deploymentVersion: null,
  timezone: "Australia/Melbourne",
  currentToken: "current-secret",
};

const AUTH = { authorization: "Bearer current-secret" };
const openApps: NestFastifyApplication[] = [];

function forbiddenPersistence(): PersistenceProvider {
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
  };
}

async function makeApp(
  activityEventReader: ActivityEventReader | null,
): Promise<NestFastifyApplication> {
  const app = await createJarvisHttpApp({
    persistence: forbiddenPersistence(),
    providerName: "json",
    config: CONFIG,
    logger: false,
    activityEventReader,
  });
  openApps.push(app);
  return app;
}

afterEach(async () => {
  await Promise.all(openApps.splice(0).map((app) => app.close()));
});

describe("operations activity timeline HTTP boundary", () => {
  it("requires authentication", async () => {
    const app = await makeApp(null);
    const response = await app.inject({ method: "GET", url: "/api/v1/operations/activity" });
    assert.equal(response.statusCode, 401);
  });

  it("reports unavailable, not an empty page, when no reader is configured", async () => {
    const app = await makeApp(null);
    const response = await app.inject({
      method: "GET",
      url: "/api/v1/operations/activity",
      headers: AUTH,
    });
    assert.equal(response.statusCode, 200);
    const body = response.json() as { data: { status: string; reason?: string } };
    assert.equal(body.data.status, "unavailable");
    assert.ok(body.data.reason);
  });

  it("returns a translated page of events from the configured reader", async () => {
    const reader: ActivityEventReader = {
      async listActivityPage() {
        return {
          events: [
            {
              activityId: "event-1",
              eventType: "tool.action.approved",
              actor: "user",
              payload: { actionId: "action-1" },
              createdAt: Date.parse("2026-07-30T10:00:00.000Z"),
            },
          ],
          continueCursor: "next-cursor",
          isDone: false,
        };
      },
    };
    const app = await makeApp(reader);
    const response = await app.inject({
      method: "GET",
      url: "/api/v1/operations/activity",
      headers: AUTH,
    });
    assert.equal(response.statusCode, 200);
    const body = response.json() as {
      data: { status: string; events: unknown[]; cursor: string; isDone: boolean };
    };
    assert.equal(body.data.status, "available");
    assert.equal(body.data.events.length, 1);
    assert.equal(body.data.cursor, "next-cursor");
    assert.equal(body.data.isDone, false);
  });

  it("passes cursor and limit query parameters through to the reader", async () => {
    const calls: Array<{ cursor: string | null; limit: number }> = [];
    const reader: ActivityEventReader = {
      async listActivityPage(input) {
        calls.push(input);
        return { events: [], continueCursor: "", isDone: true };
      },
    };
    const app = await makeApp(reader);
    await app.inject({
      method: "GET",
      url: "/api/v1/operations/activity?cursor=abc&limit=10",
      headers: AUTH,
    });
    assert.deepEqual(calls, [{ cursor: "abc", limit: 10 }]);
  });

  it("rejects an out-of-range limit", async () => {
    const app = await makeApp(null);
    const response = await app.inject({
      method: "GET",
      url: "/api/v1/operations/activity?limit=101",
      headers: AUTH,
    });
    assert.equal(response.statusCode, 422);
  });

  it("reports unavailable, not an empty page, when the configured reader's read fails", async () => {
    const reader: ActivityEventReader = {
      async listActivityPage() {
        throw new Error("audit events store offline");
      },
    };
    const app = await makeApp(reader);
    const response = await app.inject({
      method: "GET",
      url: "/api/v1/operations/activity",
      headers: AUTH,
    });
    assert.equal(response.statusCode, 200);
    const body = response.json() as { data: { status: string; reason?: string } };
    assert.equal(body.data.status, "unavailable");
    assert.equal(body.data.reason, "Activity timeline is temporarily unavailable.");
  });
});
