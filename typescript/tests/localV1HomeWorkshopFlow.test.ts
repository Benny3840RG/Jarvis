import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, describe, it } from "node:test";

import { Client, InMemoryTransport } from "@modelcontextprotocol/client";
import type { NestFastifyApplication } from "@nestjs/platform-fastify";

import { JsonAssetStore } from "../src/assets/jsonAssetStore.js";
import { JsonBuildLogStore } from "../src/buildLog/jsonBuildLogStore.js";
import { JsonBuildStore } from "../src/builds/jsonBuildStore.js";
import { JsonErrandStore } from "../src/errands/jsonErrandStore.js";
import { createJarvisHttpApp } from "../src/http/app.js";
import type { HttpAppConfig } from "../src/http/config.js";
import { JarvisApiClient } from "../src/mcp/jarvisApiClient.js";
import { createJarvisMcpServer } from "../src/mcp/server.js";
import { JSONPersistence } from "../src/persistence/jsonPersistence.js";
import { captureCredentials } from "../src/settings/credentialsStatus.js";
import { JsonUpgradeStore } from "../src/upgrades/jsonUpgradeStore.js";

/**
 * Off-host LV1-07/08 exercise. Writes go through MCP, which calls the HTTP API.
 * Restart is a new app and new JSON store instances on the same files.
 * Convex is not configured here; the provider map is the code in `app.ts`.
 */

const TOKEN = "local-v1-home-workshop-secret";
const COMPRESSOR_SERVICED_AT = Date.parse("2024-01-15T00:00:00.000Z");

const CONFIG: HttpAppConfig = {
  version: "0.1.0",
  sourceVersion: "local-v1-home-workshop",
  deploymentVersion: null,
  timezone: "Australia/Melbourne",
  currentToken: TOKEN,
  previousToken: undefined,
};

type Stores = {
  persistence: JSONPersistence;
  errandStore: JsonErrandStore;
  buildStore: JsonBuildStore;
  buildLogStore: JsonBuildLogStore;
  upgradeStore: JsonUpgradeStore;
  assetStore: JsonAssetStore;
};

function storesAt(dir: string): Stores {
  return {
    persistence: new JSONPersistence(path.join(dir, "jarvis-state.json")),
    errandStore: new JsonErrandStore(path.join(dir, "jarvis-errands.json")),
    buildStore: new JsonBuildStore(path.join(dir, "jarvis-builds.json")),
    buildLogStore: new JsonBuildLogStore(path.join(dir, "jarvis-build-logs.json")),
    upgradeStore: new JsonUpgradeStore(path.join(dir, "jarvis-upgrades.json")),
    assetStore: new JsonAssetStore(path.join(dir, "jarvis-assets.json")),
  };
}

type ToolResult = {
  isError?: boolean;
  content?: Array<{ type: string; text?: string }>;
  structuredContent?: Record<string, unknown>;
};

type Harness = { client: Client; app: NestFastifyApplication; close: () => Promise<void> };

const open: Harness[] = [];
const directories: string[] = [];

async function start(stores: Stores): Promise<Harness> {
  const app = await createJarvisHttpApp({
    ...stores,
    providerName: "json",
    config: CONFIG,
    credentialsRuntime: captureCredentials({
      serviceToken: TOKEN,
      httpHost: "127.0.0.1",
      httpPort: 3100,
      mcpHost: "127.0.0.1",
      mcpPort: 8797,
      remoteGatewayEnabled: false,
      tlsTerminated: false,
      oidcConfigured: false,
      originsConfigured: false,
      persistenceProvider: "json",
    }),
    logger: false,
  });
  await app.listen(0, "127.0.0.1");
  const apiClient = new JarvisApiClient({
    baseUrl: new URL(`${await app.getUrl()}/`),
    serviceToken: TOKEN,
  });
  const server = createJarvisMcpServer(apiClient);
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  const client = new Client({ name: "local-v1-home-workshop", version: "0.1.0" });
  await server.connect(serverTransport);
  await client.connect(clientTransport);
  const harness: Harness = {
    client,
    app,
    async close() {
      await client.close();
      await server.close();
      await app.close();
    },
  };
  open.push(harness);
  return harness;
}

async function call(client: Client, name: string, args: Record<string, unknown> = {}) {
  const result = (await client.callTool({ name, arguments: args })) as ToolResult;
  const text = result.content?.map((part) => part.text ?? "").join(" ") ?? "";
  assert.notEqual(result.isError, true, `${name} failed: ${text}`);
  assert.ok(result.structuredContent, `${name} returned no structured content`);
  return result.structuredContent;
}

afterEach(async () => {
  await Promise.all(open.splice(0).map((harness) => harness.close()));
  await Promise.all(directories.splice(0).map((dir) => rm(dir, { recursive: true, force: true })));
});

describe("LV1-07/08 home and workshop flows", () => {
  it("creates, updates, completes, restarts, and projects home records into the brief and HUD", async () => {
    const dir = await mkdtemp(path.join(tmpdir(), "jarvis-lv1-home-"));
    directories.push(dir);
    const first = await start(storesAt(dir));

    const taskDashboard = await call(first.client, "create_task", {
      title: "Pay the rates",
      category: "home",
    });
    const task = (
      taskDashboard.tasks as Array<{ id: string; title: string; completed: boolean }>
    ).find((item) => item.title === "Pay the rates");
    assert.ok(task);
    assert.equal(task.completed, false);

    const reminderDashboard = await call(first.client, "create_reminder", {
      title: "Bin night",
      due: { text: "2020-01-15 09:00", timezone: "Australia/Melbourne" },
    });
    const reminder = (
      reminderDashboard.reminders as Array<{ id: string; title: string; dueAt?: number }>
    ).find((item) => item.title === "Bin night");
    assert.ok(reminder?.dueAt);

    const errandCreated = await call(first.client, "create_errand", {
      title: "Milk",
      location: { label: "Supermarket" },
    });
    const errand = errandCreated.errand as { id: string; status: string };
    assert.equal(errand.status, "open");

    const workshopTaskDashboard = await call(first.client, "create_task", {
      title: "True the rear axle",
      category: "workshop",
    });
    const workshopTask = (
      workshopTaskDashboard.tasks as Array<{ id: string; title: string; completed: boolean }>
    ).find((item) => item.title === "True the rear axle");
    assert.ok(workshopTask);

    const buildCreated = await call(first.client, "create_build", {
      name: "RC crawler",
      kind: "RC crawler",
      status: "active",
    });
    const build = buildCreated.build as { id: string; status: string; name: string };
    assert.equal(build.status, "active");

    const logCreated = await call(first.client, "create_build_log", {
      buildId: build.id,
      kind: "milestone",
      title: "Rear bracket welded",
      body: "Rear bracket has been welded.",
    });
    const entry = logCreated.entry as { id: string; title: string; buildId: string };
    assert.equal(entry.buildId, build.id);

    const upgradeCreated = await call(first.client, "create_upgrade", {
      buildId: build.id,
      title: "Steering link",
      parts: ["rod end"],
    });
    const upgrade = upgradeCreated.upgrade as { id: string; parts?: string[] };
    assert.deepEqual(upgrade.parts, ["rod end"]);

    const assetCreated = await call(first.client, "create_asset", {
      name: "Workshop compressor",
      kind: "machine",
      serviceIntervalDays: 180,
      lastServicedAt: COMPRESSOR_SERVICED_AT,
    });
    const asset = assetCreated.asset as { id: string; lastServicedAt?: number; due: boolean };
    assert.equal(asset.lastServicedAt, COMPRESSOR_SERVICED_AT);
    assert.equal(asset.due, true);

    await call(first.client, "update_task", { taskId: task.id, title: "Pay the council rates" });
    await call(first.client, "update_reminder", {
      reminderId: reminder.id,
      title: "Bin night reminder",
    });
    await call(first.client, "update_errand", { errandId: errand.id, notes: "Full cream" });
    await call(first.client, "update_build", {
      buildId: build.id,
      description: "Current crawler build",
    });
    await call(first.client, "update_build_log", {
      entryId: entry.id,
      body: "Rear bracket has been welded and cooled.",
    });
    await call(first.client, "update_upgrade", {
      upgradeId: upgrade.id,
      outcome: "Tracks straight",
    });
    await call(first.client, "update_asset", {
      assetId: asset.id,
      notes: "Last service recorded by the operator.",
    });

    const before = await call(first.client, "get_daily_brief");
    const brief = before.brief as {
      tasks: { open: Array<{ title: string }> };
      reminders: { due: Array<{ title: string }> };
      errands: { open: Array<{ title: string }> };
      maintenance: { due: Array<{ name: string; lastServicedAt?: number }> };
    };
    assert.ok(brief.tasks.open.some((item) => item.title === "Pay the council rates"));
    assert.ok(brief.reminders.due.some((item) => item.title === "Bin night reminder"));
    assert.ok(brief.errands.open.some((item) => item.title === "Milk"));
    const compressor = brief.maintenance.due.find((item) => item.name === "Workshop compressor");
    assert.equal(compressor?.lastServicedAt, COMPRESSOR_SERVICED_AT);

    const working = await call(first.client, "list_builds");
    const builds = working.builds as Array<{ name: string; status: string }>;
    assert.ok(builds.some((item) => item.name === "RC crawler" && item.status === "active"));

    const hud = await first.app.inject({ method: "GET", url: "/api/v1/hud/snapshot" });
    assert.equal(hud.statusCode, 200);
    const snapshot = hud.json<{
      tasks: Array<{ title: string }>;
      brief: {
        errands: { open: Array<{ title: string }> };
        maintenance: { due: Array<{ name: string }> };
      };
      counts: { activeTasks: number };
    }>();
    assert.ok(snapshot.tasks.some((item) => item.title === "Pay the council rates"));
    assert.ok(snapshot.brief.errands.open.some((item) => item.title === "Milk"));
    assert.ok(snapshot.brief.maintenance.due.some((item) => item.name === "Workshop compressor"));
    assert.ok(snapshot.counts.activeTasks >= 2);

    const httpTask = await first.app.inject({
      method: "GET",
      url: `/api/v1/tasks/${task.id}`,
      headers: { authorization: `Bearer ${TOKEN}` },
    });
    assert.equal(httpTask.statusCode, 200);

    await call(first.client, "complete_task", { taskId: task.id });
    await call(first.client, "complete_task", { taskId: workshopTask.id });
    await call(first.client, "delete_reminder", { reminderId: reminder.id });
    const doneErrand = await call(first.client, "update_errand", {
      errandId: errand.id,
      status: "done",
    });
    assert.equal((doneErrand.errand as { status: string }).status, "done");
    assert.equal(typeof (doneErrand.errand as { completedAt?: number }).completedAt, "number");

    const after = await call(first.client, "get_daily_brief");
    const closed = after.brief as {
      tasks: { open: Array<{ title: string }>; completedCount: number };
      reminders: { due: Array<{ title: string }> };
      errands: { open: Array<{ title: string }> };
    };
    assert.equal(
      closed.tasks.open.some((item) => item.title === "Pay the council rates"),
      false,
    );
    assert.ok(closed.tasks.completedCount >= 2);
    assert.equal(
      closed.reminders.due.some((item) => item.title === "Bin night reminder"),
      false,
    );
    assert.equal(
      closed.errands.open.some((item) => item.title === "Milk"),
      false,
    );

    await first.close();
    open.splice(0);

    const second = await start(storesAt(dir));
    const restartedTask = await call(second.client, "get_task", { taskId: task.id });
    const persistedTask = restartedTask.task as { title: string; completed: boolean };
    assert.equal(persistedTask.title, "Pay the council rates");
    assert.equal(persistedTask.completed, true);

    const reminders = await call(second.client, "list_reminders");
    assert.equal(
      (reminders.reminders as Array<{ id: string }>).some((item) => item.id === reminder.id),
      false,
    );

    const restartedErrand = await call(second.client, "get_errand", { errandId: errand.id });
    assert.equal((restartedErrand.errand as { status: string }).status, "done");

    const restartedLog = await call(second.client, "get_build_log", { entryId: entry.id });
    assert.equal(
      (restartedLog.entry as { body?: string }).body,
      "Rear bracket has been welded and cooled.",
    );

    const restartedAsset = await call(second.client, "get_asset", { assetId: asset.id });
    assert.equal(
      (restartedAsset.asset as { lastServicedAt?: number }).lastServicedAt,
      COMPRESSOR_SERVICED_AT,
    );

    const restartedBuild = await call(second.client, "get_build", { buildId: build.id });
    assert.equal(
      (restartedBuild.build as { status: string; description?: string }).status,
      "active",
    );
    assert.equal(
      (restartedBuild.build as { description?: string }).description,
      "Current crawler build",
    );
  });
});
