import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, it } from "node:test";

import type { NestFastifyApplication } from "@nestjs/platform-fastify";

import { createJarvisHttpApp } from "../src/http/app.js";
import type { HttpAppConfig } from "../src/http/config.js";
import type { PersistenceProvider } from "../src/persistence/persistence.js";
import { DangerZoneService } from "../src/settings/dangerZone/service.js";

const CONFIG: HttpAppConfig = {
  version: "0.1.0",
  sourceVersion: "danger-zone-http-test",
  deploymentVersion: null,
  timezone: "Australia/Melbourne",
  currentToken: "current-secret",
};

const AUTH = { authorization: "Bearer current-secret" };
const SECRET = "http-super-secret-token-value";

const tempDirs: string[] = [];
const openApps: NestFastifyApplication[] = [];

function unusedPersistence(): PersistenceProvider {
  const forbidden = (): never => {
    throw new Error("persistence must not be reached in danger zone HTTP tests");
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

async function tempDir(): Promise<string> {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "jarvis-danger-http-"));
  tempDirs.push(dir);
  return dir;
}

afterEach(async () => {
  await Promise.all(openApps.splice(0).map((app) => app.close()));
  await Promise.all(tempDirs.splice(0).map((dir) => fs.rm(dir, { recursive: true, force: true })));
});

describe("danger zone HTTP", () => {
  it("requires the service token, blocks a wrong confirmation, and resets JSON without Convex", async () => {
    const dataDir = await tempDir();
    await fs.writeFile(path.join(dataDir, "jarvis-state.json"), `{"marker":"${SECRET}"}`, "utf8");
    await fs.writeFile(path.join(dataDir, "jarvis-clients.json"), "clients", "utf8");
    const runs: string[] = [];
    const zone = new DangerZoneService({
      dataDir,
      provider: "json",
      env: {},
      localEnvPath: path.join(dataDir, ".env.local"),
      backupDirectories: [],
      convexCwd: dataDir,
      lockTimeoutMs: 200,
      hostname: "http-host",
      pid: 7,
      runConvexCommand: (command, args) => {
        runs.push([command, ...args].join(" "));
        return Promise.resolve({ code: 0 });
      },
    });
    const app = await createJarvisHttpApp({
      persistence: unusedPersistence(),
      providerName: "json",
      config: CONFIG,
      logger: false,
      dangerZone: zone,
    });
    openApps.push(app);

    assert.equal(
      (await app.inject({ method: "GET", url: "/api/v1/settings/danger-zone" })).statusCode,
      401,
    );

    const page = await app.inject({
      method: "GET",
      url: "/api/v1/settings/danger-zone/page",
      headers: AUTH,
    });
    assert.equal(page.statusCode, 200);
    assert.match(String(page.headers["content-type"]), /text\/html/);
    assert.match(page.body, /Danger zone/);
    assert.match(page.body, /data-confirm="END OVERLAP"/);
    assert.match(page.body, /class="cancel" autofocus/);
    assert.equal(page.body.includes(SECRET), false);

    const wrong = await app.inject({
      method: "POST",
      url: "/api/v1/settings/danger-zone/actions/reset-local-json",
      headers: { ...AUTH, "content-type": "application/json" },
      payload: { confirmation: "reset json", acceptEmptyLocalCore: true },
    });
    assert.equal(wrong.statusCode, 422);
    assert.equal(wrong.json().detail.includes(SECRET), false);
    assert.equal((await fs.readdir(dataDir)).includes("jarvis-state.json"), true);

    const reset = await app.inject({
      method: "POST",
      url: "/api/v1/settings/danger-zone/actions/reset-local-json",
      headers: { ...AUTH, "content-type": "application/json" },
      payload: { confirmation: "RESET JSON", acceptEmptyLocalCore: true },
    });
    assert.equal(reset.statusCode, 200);
    const body = reset.json<{
      convexDataDeletes: number;
      detail: string;
      quarantinedPaths: string[];
    }>();
    assert.equal(body.convexDataDeletes, 0);
    assert.match(body.detail, /Convex data was not modified/);
    assert.equal(JSON.stringify(body).includes(SECRET), false);
    assert.deepEqual(runs, []);
    assert.equal(await fs.readFile(path.join(dataDir, "jarvis-clients.json"), "utf8"), "clients");
    const names = await fs.readdir(dataDir);
    assert.equal(names.includes("jarvis-state.json"), false);
    assert.ok(names.some((name) => name.startsWith("jarvis-state.json.corrupt-")));

    const uncleared = await app.inject({
      method: "POST",
      url: "/api/v1/settings/danger-zone/actions/clear-local",
      headers: { ...AUTH, "content-type": "application/json" },
      payload: { confirmation: "CLEAR LOCAL" },
    });
    assert.equal(uncleared.statusCode, 422);
    assert.match(uncleared.json().detail, /verified backup|explicit skip/);
    assert.equal(await fs.readFile(path.join(dataDir, "jarvis-clients.json"), "utf8"), "clients");
  });
});
