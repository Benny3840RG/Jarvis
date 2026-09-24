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

  it("does not offer or execute End when the client claims verify passed", async () => {
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
    const failingBody = failing.json() as {
      offered: boolean;
      allowed: boolean;
      executesRemoval: boolean;
      commands: string[];
      posture: string;
      dangerHref: string;
    };
    assert.equal(failingBody.offered, false);
    assert.equal(failingBody.allowed, false);
    assert.equal(failingBody.executesRemoval, false);
    assert.deepEqual(failingBody.commands, []);
    assert.equal(failingBody.posture, "not-verified");
    assert.equal(failingBody.dangerHref, "/settings/danger#service");
    assert.doesNotMatch(failing.body, /npx convex env remove/);

    const idle = await server.inject({
      method: "POST",
      url: "/api/v1/settings/credentials/end-overlap",
      headers: { authorization: `Bearer ${SERVICE}` },
      payload: {
        tokenId: "service",
        confirmation: "END OVERLAP",
        verify: "idle",
        context: "card",
      },
    });
    assert.equal(idle.statusCode, 200);
    const idleBody = idle.json() as {
      offered: boolean;
      executesRemoval: boolean;
      commands: string[];
      posture: string;
    };
    assert.equal(idleBody.offered, false);
    assert.equal(idleBody.executesRemoval, false);
    assert.equal(idleBody.posture, "not-verified");
    assert.deepEqual(idleBody.commands, []);

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
    const decision = allowed.json() as {
      offered: boolean;
      allowed: boolean;
      primary: boolean;
      executesRemoval: boolean;
      commands: string[];
      posture: string;
      dangerHref: string;
    };
    assert.equal(decision.allowed, false);
    assert.equal(decision.offered, false);
    assert.equal(decision.primary, false);
    assert.equal(decision.executesRemoval, false);
    assert.equal(decision.posture, "not-verified");
    assert.equal(decision.dangerHref, "/settings/danger#service");
    assert.deepEqual(decision.commands, []);
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

  it("serves delivery status from the environment when HttpAppConfig has no delivery token", async () => {
    const server = await createJarvisHttpApp({
      persistence: persistence(),
      providerName: "json",
      config: config(SERVICE),
      credentialsEnv: {
        JARVIS_SERVICE_TOKEN: SERVICE,
        JARVIS_APPROVAL_TOKEN: APPROVAL,
        JARVIS_DELIVERY_RUNTIME_TOKEN: DELIVERY,
        JARVIS_HTTP_HOST: "127.0.0.1",
        JARVIS_HTTP_PORT: "3000",
      },
      logger: false,
    });
    openApps.push(server);
    const status = await server.inject({
      method: "GET",
      url: "/api/v1/settings/credentials",
      headers: { authorization: `Bearer ${SERVICE}` },
    });
    assert.equal(status.statusCode, 200);
    const payload = status.json() as {
      data: { tokens: Array<{ id: string; configured: boolean; fingerprint: string | null }> };
    };
    assert.equal(payload.data.tokens[2]?.id, "delivery");
    assert.equal(payload.data.tokens[2]?.configured, true);
    assert.match(payload.data.tokens[2]?.fingerprint ?? "", /^[0-9a-f]{4}\u2026[0-9a-f]{4}$/);
    assert.equal(status.body.includes(DELIVERY), false);
    assert.equal(status.body.includes(secretDigest(SERVICE)), false);

    const page = await server.inject({ method: "GET", url: "/settings/credentials" });
    assert.equal(page.statusCode, 200);
    assert.doesNotMatch(page.body, /[0-9a-f]{64}/);
    assert.equal(page.body.includes(secretDigest(SERVICE)), false);
    assert.equal(page.body.includes(SERVICE), false);
    assert.equal(page.body.includes(DELIVERY), false);
    assert.doesNotMatch(page.body, /sessionStorage/);
    assert.match(page.body, /href="\/settings\/danger#service"/);
    assert.match(page.body, /href="\/settings\/danger#approval"/);
    assert.match(page.body, /href="\/settings\/danger#delivery"/);
    assert.doesNotMatch(page.body, /function openEnd|id="end-dialog"|endOverlapCommands/);

    const danger = await server.inject({ method: "GET", url: "/settings/danger" });
    assert.equal(danger.statusCode, 200);
    assert.match(danger.body, /Danger zone/);
    assert.match(danger.body, /id="service"/);
    assert.match(danger.body, /id="approval"/);
    assert.match(danger.body, /id="delivery"/);
    assert.match(danger.body, /href="\/settings\/credentials"/);
    assert.match(danger.body, /data-confirm="END OVERLAP"/);
    assert.match(danger.body, /Open Persistence Backup/);
    assert.match(danger.body, /Convex owner wipe needs a dedicated empty-target design/);
    assert.doesNotMatch(danger.body, /sessionStorage|[0-9a-f]{64}/);
    assert.equal(danger.body.includes(SERVICE), false);

    const httpMain = await import("node:fs").then((fs) =>
      fs.readFileSync(new URL("../src/http/main.ts", import.meta.url), "utf8"),
    );
    const previewMain = await import("node:fs").then((fs) =>
      fs.readFileSync(new URL("../src/preview/main.ts", import.meta.url), "utf8"),
    );
    const appSource = await import("node:fs").then((fs) =>
      fs.readFileSync(new URL("../src/http/app.ts", import.meta.url), "utf8"),
    );
    assert.match(appSource, /selectCredentialsRuntime\(/);
    assert.doesNotMatch(appSource, /credentialsSourceFromHttpConfig/);
    assert.doesNotMatch(httpMain, /credentialsSourceFromHttpConfig|credentialsRuntime/);
    assert.doesNotMatch(previewMain, /credentialsSourceFromHttpConfig|credentialsRuntime/);
  });
});
