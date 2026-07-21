import assert from "node:assert/strict";
import { afterEach, describe, it } from "node:test";

import type { NestFastifyApplication } from "@nestjs/platform-fastify";

import type { DailyBrief } from "../src/briefs/brief.js";
import { createJarvisHttpApp } from "../src/http/app.js";
import type { HttpAppConfig } from "../src/http/config.js";
import type { PersistenceProvider } from "../src/persistence/persistence.js";
import type { Reminder, Task } from "../src/persistence/types.js";
import { InMemoryProjectStore } from "../src/projects/inMemoryProjectStore.js";
import { InMemoryQuoteStore } from "../src/quotes/inMemoryQuoteStore.js";

const CONFIG: HttpAppConfig = {
  version: "0.1.0",
  sourceVersion: "brief-http-test",
  deploymentVersion: null,
  timezone: "Australia/Melbourne",
  currentToken: "current-secret",
  previousToken: undefined,
};

const AUTH = { authorization: "Bearer current-secret" };

/** Persistence fake serving fixed tasks/reminders; mutations are out of scope here. */
function readOnlyPersistence(tasks: Task[], reminders: Reminder[]): PersistenceProvider {
  const forbidden = (): never => {
    throw new Error("mutations must not be reached in brief HTTP tests");
  };
  return {
    loadState: forbidden,
    saveState: forbidden,
    listTasks: () => Promise.resolve(tasks),
    addTask: forbidden,
    updateTask: forbidden,
    completeTask: forbidden,
    removeTask: forbidden,
    listReminders: () => Promise.resolve(reminders),
    addReminder: forbidden,
    updateReminder: forbidden,
    removeReminder: forbidden,
  };
}

const openApps: NestFastifyApplication[] = [];

afterEach(async () => {
  await Promise.all(openApps.splice(0).map((app) => app.close()));
});

describe("brief HTTP boundary", () => {
  it("requires authentication", async () => {
    const app = await createJarvisHttpApp({
      persistence: readOnlyPersistence([], []),
      providerName: "json",
      config: CONFIG,
      logger: false,
    });
    openApps.push(app);
    assert.equal((await app.inject({ method: "GET", url: "/api/v1/brief" })).statusCode, 401);
  });

  it("composes the brief from live store contents", async () => {
    const projectStore = new InMemoryProjectStore();
    await projectStore.add({ clientId: "c1", title: "Deck rebuild", status: "active" });
    await projectStore.add({ clientId: "c1", title: "Old fence", status: "done" });

    const quoteStore = new InMemoryQuoteStore();
    await quoteStore.add({
      clientId: "c1",
      number: "Q-1",
      status: "sent",
      taxRate: 0.1,
      lineItems: [{ description: "Labour", quantity: 2, unitPrice: 100 }],
    });
    await quoteStore.add({ clientId: "c1", number: "Q-2" });

    const now = Date.now();
    const tasks: Task[] = [
      { id: "t1", title: "Order timber", completed: false, category: "builds", createdAt: 1 },
      { id: "t2", title: "Invoice sent", completed: true, category: "admin", createdAt: 2 },
    ];
    const reminders: Reminder[] = [
      {
        id: "r1",
        title: "Chase deposit",
        dueRaw: "this morning",
        dueAt: now - 1000,
        dueTimezone: "Australia/Melbourne",
        createdAt: 1,
      },
      { id: "r2", title: "Buy silicone", createdAt: 2 },
    ];

    const app = await createJarvisHttpApp({
      persistence: readOnlyPersistence(tasks, reminders),
      providerName: "json",
      config: CONFIG,
      logger: false,
      projectStore,
      quoteStore,
    });
    openApps.push(app);

    const response = await app.inject({ method: "GET", url: "/api/v1/brief", headers: AUTH });
    assert.equal(response.statusCode, 200);
    const brief = response.json<{ data: DailyBrief }>().data;

    assert.equal(brief.timezone, "Australia/Melbourne");
    assert.equal(brief.tasks.openCount, 1);
    assert.equal(brief.tasks.open[0].id, "t1");
    assert.equal(brief.reminders.dueCount, 1);
    assert.equal(brief.reminders.undatedCount, 1);
    assert.equal(brief.projects.activeCount, 1);
    assert.equal(brief.projects.countsByStatus.done, 1);
    assert.equal(brief.quotes.countsByStatus.sent, 1);
    assert.equal(brief.quotes.countsByStatus.draft, 1);
    // 2 x 100 with 10% tax, derived by the store, surfaced by the brief.
    assert.equal(brief.quotes.pipelineTotal, 220);
    assert.equal(
      brief.headline,
      "1 open task, 1 reminder due, 1 active project, 1 quote awaiting response.",
    );
  });

  it("returns 503 when a backing store cannot be read", async () => {
    const broken = readOnlyPersistence([], []);
    broken.listTasks = () => Promise.reject(new Error("store offline"));
    const app = await createJarvisHttpApp({
      persistence: broken,
      providerName: "json",
      config: CONFIG,
      logger: false,
    });
    openApps.push(app);
    const response = await app.inject({ method: "GET", url: "/api/v1/brief", headers: AUTH });
    assert.equal(response.statusCode, 503);
  });
});
