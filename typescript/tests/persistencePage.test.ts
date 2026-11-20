import assert from "node:assert/strict";
import { afterEach, describe, it } from "node:test";

import type { NestFastifyApplication } from "@nestjs/platform-fastify";

import { createJarvisHttpApp } from "../src/http/app.js";
import type { HttpAppConfig } from "../src/http/config.js";
import type { PersistenceProvider } from "../src/persistence/persistence.js";
import { captureCredentials, type CredentialsRuntime } from "../src/settings/credentialsStatus.js";
import { PERSISTENCE_BACKUP_HREF } from "../src/settings/dangerZone/confirm.js";
import { renderPersistencePage } from "../src/settings/persistencePage.js";
import {
  ARCHIVE_SECRET_WARNING,
  PERSISTENCE_COMMANDS,
  V4_CONVEX_EXPORT_COPY,
} from "../src/settings/persistenceSettings.js";

const TOKEN = "persistence-page-service-token-value";
const openApps: NestFastifyApplication[] = [];

function persistence(): PersistenceProvider {
  const none = async () => null;
  return {
    loadState: async () => ({}),
    saveState: async () => {},
    listTasks: async () => [],
    addTask: async (title: string, category: string) => ({
      id: "task-1",
      title,
      category,
      completed: false,
      createdAt: 1,
    }),
    updateTask: none,
    completeTask: none,
    removeTask: none,
    listReminders: async () => [],
    addReminder: async (title: string) => ({ id: "reminder-1", title, createdAt: 1 }),
    updateReminder: none,
    removeReminder: none,
  };
}

function config(): HttpAppConfig {
  return {
    version: "0.1.0",
    sourceVersion: "persistence-page-test",
    deploymentVersion: null,
    timezone: "Australia/Melbourne",
    currentToken: TOKEN,
  };
}

function credentials(host: string): CredentialsRuntime {
  return captureCredentials({
    serviceToken: TOKEN,
    httpHost: host,
    httpPort: 3000,
    mcpHost: "127.0.0.1",
    mcpPort: 8787,
    remoteGatewayEnabled: false,
    tlsTerminated: false,
    oidcConfigured: false,
    originsConfigured: false,
    persistenceProvider: "json",
  });
}

afterEach(async () => {
  await Promise.all(openApps.splice(0).map((item) => item.close()));
});

describe("persistence page", () => {
  it("is the Danger zone backup target and lists every exposed command", () => {
    const html = renderPersistencePage("json");
    assert.equal(PERSISTENCE_BACKUP_HREF, "/settings/persistence#backup");
    assert.match(html, /id="backup"/);
    assert.match(html, /aria-current="page">Persistence</);
    for (const entry of PERSISTENCE_COMMANDS) {
      const escaped = entry.command.replaceAll("<", "&lt;").replaceAll(">", "&gt;");
      assert.equal(html.includes(escaped), entry.exposedInSettings, entry.command);
    }
    assert.ok(html.includes(ARCHIVE_SECRET_WARNING));
    assert.match(html, /Partial \/ JSON-only/);
    assert.match(html, /data-chip="provider">json</);
    assert.equal(html.includes(V4_CONVEX_EXPORT_COPY), false);
  });

  it("runs nothing: no script, form, button, token storage or provider switch", () => {
    const html = renderPersistencePage("convex");
    assert.doesNotMatch(html, /<script|<form|<button|<input|sessionStorage|localStorage/i);
    assert.doesNotMatch(html, /type="radio"|try json instead|fall back to json/i);
    assert.ok(html.includes(V4_CONVEX_EXPORT_COPY));
    assert.match(html, /data-chip="provider">convex</);
  });
});

describe("persistence HTTP page", () => {
  it("serves the page on loopback and hides it off loopback", async () => {
    const local = await createJarvisHttpApp({
      persistence: persistence(),
      providerName: "json",
      config: config(),
      credentialsRuntime: credentials("127.0.0.1"),
      logger: false,
    });
    openApps.push(local);
    const page = await local.inject({ method: "GET", url: "/settings/persistence" });
    assert.equal(page.statusCode, 200);
    assert.match(page.headers["content-type"] ?? "", /text\/html/);
    assert.equal(page.headers["cache-control"], "no-store");
    assert.match(String(page.headers["content-security-policy"]), /default-src 'none'/);
    assert.doesNotMatch(String(page.headers["content-security-policy"]), /script-src/);
    assert.match(page.body, /id="backup"/);
    assert.equal(page.body.includes(TOKEN), false);

    const remote = await createJarvisHttpApp({
      persistence: persistence(),
      providerName: "json",
      config: config(),
      credentialsRuntime: credentials("10.1.1.1"),
      logger: false,
    });
    openApps.push(remote);
    const hidden = await remote.inject({ method: "GET", url: "/settings/persistence" });
    assert.equal(hidden.statusCode, 404);
    assert.equal(hidden.body.includes(TOKEN), false);
  });
});
