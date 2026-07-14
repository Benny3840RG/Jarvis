import assert from "node:assert/strict";
import fs from "node:fs/promises";
import { afterEach, describe, it } from "node:test";

import type { NestFastifyApplication } from "@nestjs/platform-fastify";

import { createJarvisHttpApp } from "../src/http/app.js";
import {
  resolveHttpAppConfig,
  resolveHttpListenConfig,
  type HttpAppConfig,
} from "../src/http/config.js";
import type { ProblemDetails } from "../src/http/problemDetails.js";
import {
  resolvePersistenceProviderName,
  type AssistantState,
  type PersistenceProvider,
  type Reminder,
  type ReminderDue,
  type ReminderUpdate,
  type Task,
  type TaskUpdate,
} from "../src/persistence/persistence.js";

const BASE_CONFIG: HttpAppConfig = {
  version: "0.1.0",
  sourceVersion: "test-source-0001",
  deploymentVersion: null,
  timezone: "Australia/Melbourne",
  currentToken: "current-secret",
  previousToken: "previous-secret",
};

const openApps: NestFastifyApplication[] = [];

function makePersistence(overrides: Partial<PersistenceProvider> = {}): PersistenceProvider {
  const task: Task = {
    id: "task-1",
    title: "Test task",
    completed: false,
    category: "test",
    createdAt: 1,
  };
  const reminder: Reminder = {
    id: "reminder-1",
    title: "Test reminder",
    createdAt: 1,
  };

  return {
    async loadState(): Promise<AssistantState> {
      return {};
    },
    async saveState(_state: AssistantState): Promise<void> {},
    async listTasks(): Promise<Task[]> {
      return [];
    },
    async addTask(_title: string, _category: string): Promise<Task> {
      return task;
    },
    async updateTask(_id: string, _update: TaskUpdate): Promise<Task | null> {
      return task;
    },
    async completeTask(_id: string): Promise<Task | null> {
      return task;
    },
    async removeTask(_id: string): Promise<Task | null> {
      return task;
    },
    async listReminders(): Promise<Reminder[]> {
      return [];
    },
    async addReminder(_title: string, _due?: ReminderDue): Promise<Reminder> {
      return reminder;
    },
    async updateReminder(_id: string, _update: ReminderUpdate): Promise<Reminder | null> {
      return reminder;
    },
    async removeReminder(_id: string): Promise<Reminder | null> {
      return reminder;
    },
    ...overrides,
  };
}

async function makeApp(
  options: {
    persistence?: PersistenceProvider;
    providerName?: "json" | "convex";
    config?: Partial<HttpAppConfig>;
  } = {},
): Promise<NestFastifyApplication> {
  const app = await createJarvisHttpApp({
    persistence: options.persistence ?? makePersistence(),
    providerName: options.providerName ?? "json",
    config: { ...BASE_CONFIG, ...options.config },
    logger: false,
  });
  openApps.push(app);
  return app;
}

afterEach(async () => {
  await Promise.all(openApps.splice(0).map((app) => app.close()));
});

describe("Jarvis HTTP system boundary", () => {
  it("serves public liveness without authentication or persistence access", async () => {
    const persistence = makePersistence({
      async loadState() {
        throw new Error("health must not load state");
      },
      async listTasks() {
        throw new Error("health must not list tasks");
      },
      async listReminders() {
        throw new Error("health must not list reminders");
      },
    });
    const app = await makeApp({
      persistence,
      config: { currentToken: undefined, previousToken: undefined },
    });

    const response = await app
      .getHttpAdapter()
      .getInstance()
      .inject({
        method: "GET",
        url: "/healthz",
        headers: { "x-request-id": "request-1234" },
      });
    const body = response.json<{
      status: string;
      service: string;
      version: string;
      time: string;
    }>();

    assert.equal(response.statusCode, 200);
    assert.equal(response.headers["x-request-id"], "request-1234");
    assert.equal(response.headers["cache-control"], "no-store");
    assert.equal(response.headers["x-content-type-options"], "nosniff");
    assert.deepEqual(
      { status: body.status, service: body.service, version: body.version },
      { status: "ok", service: "jarvis", version: "0.1.0" },
    );
    assert.equal(Number.isNaN(Date.parse(body.time)), false);
  });

  it("returns only the capabilities implemented by this adapter slice", async () => {
    const app = await makeApp();
    const response = await app
      .getHttpAdapter()
      .getInstance()
      .inject({
        method: "GET",
        url: "/api/v1/help",
        headers: { authorization: "Bearer current-secret" },
      });

    assert.equal(response.statusCode, 200);
    assert.deepEqual(response.json(), {
      apiVersion: "v1",
      capabilities: [
        {
          operationId: "getHealth",
          summary: "Check process liveness",
          mutating: false,
          destructive: false,
          mcpExposed: false,
        },
        {
          operationId: "getHelp",
          summary: "List supported operator capabilities",
          mutating: false,
          destructive: false,
          mcpExposed: false,
        },
        {
          operationId: "getJarvisStatus",
          summary: "Inspect Jarvis runtime and provider status",
          mutating: false,
          destructive: false,
          mcpExposed: true,
        },
        {
          operationId: "reasonWithTotality",
          summary: "Run proposal-only Totality reasoning with validation and audit journalling",
          mutating: true,
          destructive: false,
          mcpExposed: false,
        },
      ],
    });
  });

  it("keeps implemented capability metadata aligned with the OpenAPI contract", async () => {
    const contract = JSON.parse(
      await fs.readFile(new URL("../openapi/jarvis.openapi.json", import.meta.url), "utf8"),
    ) as {
      paths: Record<
        string,
        Record<
          string,
          {
            operationId: string;
            summary: string;
            "x-mcp-tool": {
              exposed: boolean;
              annotations: { destructiveHint: boolean };
            };
          }
        >
      >;
    };
    const implementedRoutes = [
      ["/healthz", "get"],
      ["/api/v1/help", "get"],
      ["/api/v1/status", "get"],
      ["/api/v1/totality/reason", "post"],
    ] as const;
    const contractCapabilities = implementedRoutes.map(([path, method]) => {
      const operation = contract.paths[path][method];
      return {
        operationId: operation.operationId,
        summary: operation.summary,
        mutating: method !== "get",
        destructive: operation["x-mcp-tool"].annotations.destructiveHint,
        mcpExposed: operation["x-mcp-tool"].exposed,
      };
    });
    const app = await makeApp();
    const response = await app
      .getHttpAdapter()
      .getInstance()
      .inject({
        method: "GET",
        url: "/api/v1/help",
        headers: { authorization: "Bearer current-secret" },
      });

    assert.deepEqual(
      response.json<{ capabilities: unknown[] }>().capabilities,
      contractCapabilities,
    );
  });

  it("accepts current and overlap tokens", async () => {
    const app = await makeApp();
    for (const token of ["current-secret", "previous-secret"]) {
      const response = await app
        .getHttpAdapter()
        .getInstance()
        .inject({
          method: "GET",
          url: "/api/v1/help",
          headers: { authorization: `Bearer ${token}` },
        });
      assert.equal(response.statusCode, 200);
    }
  });

  it("rejects missing, malformed, and invalid credentials without leaking tokens", async () => {
    const app = await makeApp();
    const authorizationValues = [undefined, "Basic abc", "Bearer attacker-secret"];

    for (const authorization of authorizationValues) {
      const response = await app
        .getHttpAdapter()
        .getInstance()
        .inject({
          method: "GET",
          url: "/api/v1/help",
          headers: {
            "x-request-id": "auth-request-1",
            ...(authorization === undefined ? {} : { authorization }),
          },
        });
      const body = response.json<ProblemDetails>();
      const serialized = JSON.stringify(body);

      assert.equal(response.statusCode, 401);
      assert.match(response.headers["content-type"] ?? "", /^application\/problem\+json/);
      assert.equal(response.headers["www-authenticate"], "Bearer");
      assert.equal(response.headers["x-request-id"], "auth-request-1");
      assert.deepEqual(body, {
        type: "urn:jarvis:problem:unauthorized",
        title: "Unauthorized",
        status: 401,
        detail: "A valid Bearer service token is required.",
        instance: "/api/v1/help",
        requestId: "auth-request-1",
      });
      assert.equal(serialized.includes("current-secret"), false);
      assert.equal(serialized.includes("previous-secret"), false);
      assert.equal(serialized.includes("attacker-secret"), false);
    }
  });

  it("fails closed when only an orphaned previous token is configured", async () => {
    const app = await makeApp({ config: { currentToken: undefined } });
    const response = await app
      .getHttpAdapter()
      .getInstance()
      .inject({
        method: "GET",
        url: "/api/v1/help",
        headers: { authorization: "Bearer previous-secret" },
      });

    assert.equal(response.statusCode, 503);
    assert.deepEqual(response.json<ProblemDetails>(), {
      type: "urn:jarvis:problem:authentication-unavailable",
      title: "Service Authentication Unavailable",
      status: 503,
      detail: "Jarvis service authentication is not configured.",
      instance: "/api/v1/help",
      requestId: response.headers["x-request-id"],
    });
  });

  it("checks persistence and reports truthful Z-State readiness", async () => {
    const reads = { state: 0, tasks: 0, reminders: 0 };
    const persistence = makePersistence({
      async loadState() {
        reads.state += 1;
        return { lastIntent: "status" };
      },
      async listTasks() {
        reads.tasks += 1;
        return [];
      },
      async listReminders() {
        reads.reminders += 1;
        return [];
      },
    });
    const app = await makeApp({
      persistence,
      providerName: "convex",
      config: { deploymentVersion: "dev/outgoing-ram-798" },
    });
    const response = await app
      .getHttpAdapter()
      .getInstance()
      .inject({
        method: "GET",
        url: "/api/v1/status",
        headers: { authorization: "Bearer current-secret" },
      });
    const body = response.json<Record<string, unknown>>() as {
      status: string;
      version: string;
      sourceVersion: string;
      provider: Record<string, unknown>;
      timezone: string;
      layers: Record<string, { status: string; reason?: string }>;
      zState: string;
      checkedAt: string;
    };

    assert.equal(response.statusCode, 200);
    assert.deepEqual(reads, { state: 1, tasks: 1, reminders: 1 });
    assert.equal(body.status, "ok");
    assert.equal(body.version, "0.1.0");
    assert.equal(body.sourceVersion, "test-source-0001");
    assert.deepEqual(body.provider, {
      name: "convex",
      reachability: "ok",
      authentication: "ok",
      schemaCompatibility: "compatible",
      deploymentVersion: "dev/outgoing-ram-798",
    });
    assert.equal(body.timezone, "Australia/Melbourne");
    assert.equal(body.layers.runtime.status, "partial");
    assert.equal(body.layers.integration.status, "inactive");
    assert.equal(body.layers.reliability.status, "inactive");
    assert.equal(body.zState, "disabled");
    assert.equal(Number.isNaN(Date.parse(body.checkedAt)), false);
  });

  it("returns a redacted service problem when persistence is unavailable", async () => {
    const persistence = makePersistence({
      async listTasks() {
        throw new Error("failed with current-secret and attacker-secret");
      },
    });
    const app = await makeApp({ persistence });
    const response = await app
      .getHttpAdapter()
      .getInstance()
      .inject({
        method: "GET",
        url: "/api/v1/status",
        headers: {
          authorization: "Bearer current-secret",
          "x-request-id": "status-request-1",
        },
      });
    const body = response.json<ProblemDetails>();
    const serialized = JSON.stringify(body);

    assert.equal(response.statusCode, 503);
    assert.deepEqual(body, {
      type: "urn:jarvis:problem:persistence-unavailable",
      title: "Persistence Unavailable",
      status: 503,
      detail: "The configured persistence provider could not be reached or validated.",
      instance: "/api/v1/status",
      requestId: "status-request-1",
    });
    assert.equal(serialized.includes("current-secret"), false);
    assert.equal(serialized.includes("attacker-secret"), false);
  });

  it("rejects an invalid timezone before touching persistence", async () => {
    let reads = 0;
    const persistence = makePersistence({
      async loadState() {
        reads += 1;
        return {};
      },
    });
    const app = await makeApp({
      persistence,
      config: { timezone: "Not/A-Timezone" },
    });
    const response = await app
      .getHttpAdapter()
      .getInstance()
      .inject({
        method: "GET",
        url: "/api/v1/status",
        headers: { authorization: "Bearer current-secret" },
      });

    assert.equal(response.statusCode, 503);
    assert.equal(reads, 0);
    assert.equal(response.json<ProblemDetails>().type, "urn:jarvis:problem:timezone-unavailable");
  });

  it("uses safe generated request IDs and strips query strings from problem instances", async () => {
    const app = await makeApp();
    const response = await app
      .getHttpAdapter()
      .getInstance()
      .inject({
        method: "GET",
        url: "/missing/current-secret?token=current-secret",
        headers: { "x-request-id": "current-secret" },
      });
    const body = response.json<ProblemDetails>();

    assert.equal(response.statusCode, 404);
    assert.match(body.requestId, /^[0-9a-f-]{36}$/);
    assert.equal(response.headers["x-request-id"], body.requestId);
    assert.equal(body.instance, "/missing/redacted");
    assert.equal(JSON.stringify(body).includes("current-secret"), false);
  });
});

describe("Jarvis HTTP configuration", () => {
  it("defaults to a loopback listener and a stable development source identifier", () => {
    assert.deepEqual(resolveHttpListenConfig({}), { host: "127.0.0.1", port: 3000 });
    assert.equal(resolveHttpAppConfig({}).sourceVersion, "development");
  });

  it("validates listener and source-version configuration", () => {
    assert.deepEqual(
      resolveHttpListenConfig({ JARVIS_HTTP_HOST: "::1", JARVIS_HTTP_PORT: "8080" }),
      { host: "::1", port: 8080 },
    );
    assert.throws(
      () => resolveHttpListenConfig({ JARVIS_HTTP_HOST: "bad host" }),
      /JARVIS_HTTP_HOST/,
    );
    assert.throws(() => resolveHttpListenConfig({ JARVIS_HTTP_PORT: "0" }), /JARVIS_HTTP_PORT/);
    assert.throws(() => resolveHttpListenConfig({ JARVIS_HTTP_PORT: "3.5" }), /JARVIS_HTTP_PORT/);
    assert.throws(
      () => resolveHttpAppConfig({ JARVIS_SOURCE_VERSION: "short" }),
      /JARVIS_SOURCE_VERSION/,
    );
    assert.throws(
      () => resolveHttpAppConfig({ JARVIS_SOURCE_VERSION: "unsafe source" }),
      /JARVIS_SOURCE_VERSION/,
    );
    assert.throws(
      () => resolveHttpAppConfig({ JARVIS_DEPLOYMENT_VERSION: "unsafe deployment" }),
      /JARVIS_DEPLOYMENT_VERSION/,
    );
    assert.throws(
      () => resolveHttpAppConfig({ JARVIS_SERVICE_TOKEN: "unsafe token" }),
      /must not contain whitespace/,
    );
  });

  it("normalises the persistence provider name without silently falling back", () => {
    assert.equal(resolvePersistenceProviderName(undefined), "json");
    assert.equal(resolvePersistenceProviderName(" CONVEX "), "convex");
    assert.throws(() => resolvePersistenceProviderName("sqlite"), /Invalid PERSISTENCE_PROVIDER/);
  });

  it("requires injected persistence to declare its provider name", async () => {
    await assert.rejects(
      () =>
        createJarvisHttpApp({
          persistence: makePersistence(),
        } as unknown as Parameters<typeof createJarvisHttpApp>[0]),
      /requires its explicit provider name/,
    );
  });
});
