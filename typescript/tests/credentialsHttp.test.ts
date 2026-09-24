import assert from "node:assert/strict";
import { afterEach, describe, it } from "node:test";

import type { NestFastifyApplication } from "@nestjs/platform-fastify";

import { createJarvisHttpApp } from "../src/http/app.js";
import type { HttpAppConfig } from "../src/http/config.js";
import {
  captureCredentials,
  secretDigest,
  type CredentialsRuntime,
} from "../src/settings/credentialsStatus.js";
import type {
  AssistantState,
  PersistenceProvider,
  Reminder,
  ReminderDue,
  ReminderUpdate,
  Task,
} from "../src/persistence/persistence.js";

const SERVICE = "service-token-value-0123456789abcdef-EXTRA";
const APPROVAL = "approval-token-value-0123456789abcdef-EXTRA";
const DELIVERY = "delivery-token-value-0123456789abcdef-EXTRA";

const openApps: NestFastifyApplication[] = [];

function persistence(): PersistenceProvider {
  return {
    async loadState(): Promise<AssistantState> {
      return {};
    },
    async saveState(): Promise<void> {},
    async listTasks(): Promise<Task[]> {
      return [];
    },
    async addTask(title: string, category: string): Promise<Task> {
      return { id: "task-1", title, category, completed: false, createdAt: 1 };
    },
    async updateTask(): Promise<Task | null> {
      return null;
    },
    async completeTask(): Promise<Task | null> {
      return null;
    },
    async removeTask(): Promise<Task | null> {
      return null;
    },
    async listReminders(): Promise<Reminder[]> {
      return [];
    },
    async addReminder(title: string, _due?: ReminderDue): Promise<Reminder> {
      return { id: "reminder-1", title, createdAt: 1 };
    },
    async updateReminder(_id: string, _update: ReminderUpdate): Promise<Reminder | null> {
      return null;
    },
    async removeReminder(): Promise<Reminder | null> {
      return null;
    },
  };
}

function config(token: string | undefined): HttpAppConfig {
  return {
    version: "0.1.0",
    sourceVersion: "credentials-test",
    deploymentVersion: null,
    timezone: "Australia/Melbourne",
    ...(token === undefined ? {} : { currentToken: token }),
  };
}

async function app(
  credentialsRuntime: CredentialsRuntime,
  token: string | null = SERVICE,
): Promise<NestFastifyApplication> {
  const created = await createJarvisHttpApp({
    persistence: persistence(),
    providerName: "json",
    config: config(token ?? undefined),
    credentialsRuntime,
    logger: false,
  });
  openApps.push(created);
  return created;
}

afterEach(async () => {
  await Promise.all(openApps.splice(0).map((item) => item.close()));
});

describe("credentials HTTP boundary", () => {
  it("returns fingerprints only and refuses a delivery digest that matches the service token", async () => {
    const credentials = captureCredentials({
      serviceToken: SERVICE,
      approvalToken: APPROVAL,
      deliveryToken: DELIVERY,
      httpHost: "127.0.0.1",
      httpPort: 3000,
      mcpHost: "127.0.0.1",
      mcpPort: 8787,
      remoteGatewayEnabled: false,
      tlsTerminated: false,
      oidcConfigured: false,
      originsConfigured: false,
      persistenceProvider: "json",
    });
    const server = await app(credentials);
    const response = await server.inject({
      method: "GET",
      url: "/api/v1/settings/credentials",
      headers: { authorization: `Bearer ${SERVICE}` },
    });
    assert.equal(response.statusCode, 200);
    const body = response.body;
    assert.equal(body.includes(SERVICE), false);
    assert.equal(body.includes(APPROVAL), false);
    assert.equal(body.includes(DELIVERY), false);
    assert.equal(body.includes(secretDigest(SERVICE)), false);
    const payload = response.json() as {
      data: { tokens: Array<{ id: string; fingerprint: string }> };
    };
    assert.deepEqual(
      payload.data.tokens.map((token) => token.id),
      ["service", "approval", "delivery"],
    );
    assert.match(payload.data.tokens[0]?.fingerprint ?? "", /^[0-9a-f]{4}\u2026[0-9a-f]{4}$/);

    const collision = await server.inject({
      method: "POST",
      url: "/api/v1/settings/credentials/delivery-check",
      headers: { authorization: `Bearer ${SERVICE}` },
      payload: { digestSha256: secretDigest(SERVICE) },
    });
    assert.equal(collision.statusCode, 200);
    assert.deepEqual(collision.json(), { equalsServiceToken: true });
    assert.equal(collision.body.includes(SERVICE), false);

    const distinct = await server.inject({
      method: "POST",
      url: "/api/v1/settings/credentials/delivery-check",
      headers: { authorization: `Bearer ${SERVICE}` },
      payload: { digestSha256: secretDigest(DELIVERY) },
    });
    assert.deepEqual(distinct.json(), { equalsServiceToken: false });

    const leaked = await server.inject({
      method: "POST",
      url: "/api/v1/settings/credentials/delivery-check",
      headers: { authorization: `Bearer ${SERVICE}` },
      payload: { digestSha256: SERVICE },
    });
    assert.equal(leaked.statusCode, 400);
    assert.equal(leaked.body.includes(SERVICE), false);
  });

  it("rejects end overlap unless the typed phrase matches and verification is not failing", async () => {
    const credentials = captureCredentials({
      serviceToken: SERVICE,
      httpHost: "127.0.0.1",
      httpPort: 3000,
      mcpHost: "127.0.0.1",
      mcpPort: 8787,
      remoteGatewayEnabled: false,
      tlsTerminated: false,
      oidcConfigured: false,
      originsConfigured: false,
      persistenceProvider: "json",
    });
    const server = await app(credentials);
    const failing = await server.inject({
      method: "POST",
      url: "/api/v1/settings/credentials/end-overlap",
      headers: { authorization: `Bearer ${SERVICE}` },
      payload: {
        tokenId: "service",
        confirmation: "END OVERLAP",
        verify: "failing",
        context: "wizard",
      },
    });
    assert.equal(failing.statusCode, 200);
    assert.deepEqual(failing.json(), {
      offered: false,
      primary: false,
      allowed: false,
      commands: [],
    });

    const pasted = await server.inject({
      method: "POST",
      url: "/api/v1/settings/credentials/end-overlap",
      headers: { authorization: `Bearer ${SERVICE}` },
      payload: {
        tokenId: "service",
        confirmation: SERVICE,
        verify: "passing",
        context: "wizard",
      },
    });
    assert.equal(pasted.statusCode, 400);
    assert.equal(pasted.body.includes(SERVICE), false);

    const allowed = await server.inject({
      method: "POST",
      url: "/api/v1/settings/credentials/end-overlap",
      headers: { authorization: `Bearer ${SERVICE}` },
      payload: {
        tokenId: "service",
        confirmation: "END OVERLAP",
        verify: "passing",
        context: "wizard",
      },
    });
    assert.equal(allowed.statusCode, 200);
    const decision = allowed.json() as { allowed: boolean; primary: boolean; commands: string[] };
    assert.equal(decision.allowed, true);
    assert.equal(decision.primary, false);
    assert.match(decision.commands[0] ?? "", /npx convex env remove JARVIS_SERVICE_TOKEN_PREVIOUS/);
    assert.equal(allowed.body.includes(SERVICE), false);
  });

  it("shows a fail-closed banner on the loopback page and refuses dependent status without a service token", async () => {
    const credentials = captureCredentials({
      httpHost: "127.0.0.1",
      httpPort: 3000,
      mcpHost: "127.0.0.1",
      mcpPort: 8787,
      remoteGatewayEnabled: false,
      tlsTerminated: false,
      oidcConfigured: false,
      originsConfigured: false,
      persistenceProvider: "json",
    });
    const server = await app(credentials, null);
    const page = await server.inject({ method: "GET", url: "/settings/credentials" });
    assert.equal(page.statusCode, 200);
    assert.match(page.headers["content-type"] ?? "", /text\/html/);
    assert.equal(page.headers["cache-control"], "no-store");
    assert.match(page.body, /fail-closed/);
    assert.match(page.body, /Approvals unavailable/);

    const status = await server.inject({ method: "GET", url: "/api/v1/status" });
    assert.equal(status.statusCode, 503);
    assert.match(status.body, /fail-closed/);
    const credentialsStatus = await server.inject({
      method: "GET",
      url: "/api/v1/settings/credentials",
    });
    assert.equal(credentialsStatus.statusCode, 503);
    assert.match(credentialsStatus.body, /fail-closed/);
  });

  it("does not serve the generate page off loopback", async () => {
    const credentials = captureCredentials({
      serviceToken: SERVICE,
      httpHost: "10.1.1.1",
      httpPort: 3000,
      mcpHost: "127.0.0.1",
      mcpPort: 8787,
      remoteGatewayEnabled: true,
      tlsTerminated: false,
      oidcConfigured: false,
      originsConfigured: false,
      persistenceProvider: "json",
    });
    const server = await app(credentials);
    const page = await server.inject({ method: "GET", url: "/settings/credentials" });
    assert.equal(page.statusCode, 404);
    assert.equal(page.body.includes(SERVICE), false);
    assert.doesNotMatch(page.body, /Generate new token/);
  });
});
