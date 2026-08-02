import assert from "node:assert/strict";
import fs from "node:fs/promises";
import { describe, it } from "node:test";

import type { NestFastifyApplication } from "@nestjs/platform-fastify";

import { createJarvisHttpApp, type RegisteredRoute } from "../src/http/app.js";
import type {
  AssistantState,
  PersistenceProvider,
  Reminder,
  ReminderDue,
  ReminderUpdate,
  Task,
  TaskUpdate,
} from "../src/persistence/persistence.js";

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
    async updateTask(_id: string, _update: TaskUpdate): Promise<Task | null> {
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

describe("HTTP and OpenAPI route alignment", () => {
  it("documents every route served by the running HTTP adapter", async () => {
    const registeredRoutes: RegisteredRoute[] = [];
    let app: NestFastifyApplication | null = null;
    try {
      app = await createJarvisHttpApp({
        persistence: persistence(),
        providerName: "json",
        config: {
          version: "test",
          sourceVersion: "test-source",
          deploymentVersion: null,
          timezone: "Australia/Melbourne",
          currentToken: "current-secret",
          previousToken: undefined,
        },
        logger: false,
        onRoute: (route) => registeredRoutes.push(route),
      });

      const contract = JSON.parse(
        await fs.readFile(new URL("../openapi/jarvis.openapi.json", import.meta.url), "utf8"),
      ) as {
        paths: Record<string, Record<string, { operationId?: string; "x-mcp-tool"?: unknown }>>;
      };
      const methods = new Set(["get", "post", "put", "patch", "delete"]);
      const documentedRoutes = new Set<string>();
      const operationIds = new Set<string>();

      for (const [path, operations] of Object.entries(contract.paths)) {
        for (const [method, operation] of Object.entries(operations)) {
          if (!methods.has(method)) continue;
          documentedRoutes.add(`${method.toUpperCase()} ${path}`);
          if (!operation.operationId) continue;
          assert.equal(
            operationIds.has(operation.operationId),
            false,
            `Duplicate OpenAPI operationId: ${operation.operationId}`,
          );
          operationIds.add(operation.operationId);
        }
      }

      for (const route of registeredRoutes) {
        if (!methods.has(route.method.toLowerCase())) continue;
        const normalized = route.url.replace(/:([A-Za-z0-9_]+)/g, "{$1}");
        assert.ok(
          documentedRoutes.has(`${route.method.toUpperCase()} ${normalized}`),
          `Served route is absent from OpenAPI: ${route.method.toUpperCase()} ${normalized}`,
        );
      }
    } finally {
      if (app) await app.close();
    }
  });
});
