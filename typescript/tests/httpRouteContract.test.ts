import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { describe, it } from "node:test";

import type { NestFastifyApplication } from "@nestjs/platform-fastify";

type InjectMethod = "GET" | "POST" | "PUT" | "PATCH" | "DELETE";

import { createJarvisHttpApp, type RegisteredRoute } from "../src/http/app.js";
import type { HttpAppConfig } from "../src/http/config.js";
import type { PersistenceProvider } from "../src/persistence/persistence.js";

const HTTP_METHODS = new Set(["GET", "POST", "PUT", "PATCH", "DELETE"]);

const CONFIG: HttpAppConfig = {
  version: "0.1.0",
  sourceVersion: "route-contract-test",
  deploymentVersion: null,
  timezone: "Australia/Melbourne",
  currentToken: "current-secret",
  previousToken: undefined,
};

// Operations the OpenAPI contract documents but the HTTP app deliberately does
// not serve: the backup operations are the `runBackup` CLI tool, and the
// conversations endpoint is not implemented over HTTP.
const DOCUMENTED_NOT_SERVED = new Set([
  "GET /api/v1/backups/export",
  "POST /api/v1/backups/verify",
  "POST /api/v1/backups/restore",
  "POST /api/v1/runtime/conversations",
]);

// The only route that opts out of the service-token guard.
const PUBLIC_OPERATIONS = new Set(["GET /healthz"]);

function unusedPersistence(): PersistenceProvider {
  const forbidden = (): never => {
    throw new Error("persistence must not be reached in the route contract test");
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

async function makeAppWithRoutes(): Promise<{
  app: NestFastifyApplication;
  routes: RegisteredRoute[];
}> {
  const routes: RegisteredRoute[] = [];
  const app = await createJarvisHttpApp({
    persistence: unusedPersistence(),
    providerName: "json",
    config: CONFIG,
    logger: false,
    onRoute: (route) => routes.push(route),
  });
  return { app, routes };
}

/** Fastify `:param` form → OpenAPI `{param}` form; drops the auto-added HEAD twins. */
function servedOperations(routes: RegisteredRoute[]): Set<string> {
  const operations = new Set<string>();
  for (const route of routes) {
    const method = route.method.toUpperCase();
    if (!HTTP_METHODS.has(method)) continue; // skip auto HEAD/OPTIONS
    const url = route.url.replace(/:([A-Za-z0-9_]+)/g, "{$1}");
    operations.add(`${method} ${url}`);
  }
  return operations;
}

function openApiOperations(): Set<string> {
  const raw = readFileSync(new URL("../openapi/jarvis.openapi.json", import.meta.url), "utf8");
  const document = JSON.parse(raw) as { paths: Record<string, Record<string, unknown>> };
  const operations = new Set<string>();
  for (const [path, item] of Object.entries(document.paths)) {
    for (const method of Object.keys(item)) {
      if (HTTP_METHODS.has(method.toUpperCase())) operations.add(`${method.toUpperCase()} ${path}`);
    }
  }
  return operations;
}

/** Fills path params with a placeholder so an unauthenticated probe reaches the guard. */
function concretePath(operation: string): string {
  const [, url] = operation.split(" ", 2);
  return url.replace(/\{[A-Za-z0-9_]+\}/g, "placeholder");
}

describe("HTTP route contract", () => {
  it("serves exactly the OpenAPI operations, minus the documented-not-served set", async () => {
    const { app, routes } = await makeAppWithRoutes();
    try {
      const served = servedOperations(routes);
      const documented = openApiOperations();

      const undocumented = [...served].filter((operation) => !documented.has(operation));
      assert.deepEqual(
        undocumented,
        [],
        `App serves routes absent from the OpenAPI contract: ${undocumented.join(", ")}`,
      );

      const missing = [...documented].filter(
        (operation) => !served.has(operation) && !DOCUMENTED_NOT_SERVED.has(operation),
      );
      assert.deepEqual(
        missing,
        [],
        `OpenAPI documents operations the app does not serve: ${missing.join(", ")}`,
      );

      // Guard against the allowlist silently masking a route that later gets served.
      const nowServed = [...DOCUMENTED_NOT_SERVED].filter((operation) => served.has(operation));
      assert.deepEqual(
        nowServed,
        [],
        `Allowlisted operations are now served and should be removed from the allowlist: ${nowServed.join(", ")}`,
      );
    } finally {
      await app.close();
    }
  });

  it("guards every served operation except the public liveness route", async () => {
    const { app, routes } = await makeAppWithRoutes();
    try {
      for (const operation of servedOperations(routes)) {
        const [method] = operation.split(" ", 1);
        const response = await app.inject({
          method: method as InjectMethod,
          url: concretePath(operation),
        });
        if (PUBLIC_OPERATIONS.has(operation)) {
          assert.notEqual(
            response.statusCode,
            401,
            `${operation} should be public but rejected an unauthenticated request.`,
          );
        } else {
          assert.equal(
            response.statusCode,
            401,
            `${operation} served an unauthenticated request instead of rejecting it.`,
          );
        }
      }
    } finally {
      await app.close();
    }
  });
});
