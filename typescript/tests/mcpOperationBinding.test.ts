import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { describe, it } from "node:test";

import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";

import type { SystemStatus } from "../src/http/contracts.js";
import { JarvisApiClient } from "../src/mcp/jarvisApiClient.js";
import { createJarvisMcpServer } from "../src/mcp/server.js";
import { MCP_TOOL_OPERATIONS, formatOperation } from "../src/mcp/operationContract.js";

const HTTP_METHODS = new Set(["get", "post", "put", "patch", "delete"]);
const SERVICE_TOKEN = "binding-test-token";

// A mutating tool refreshes the operator console after its write, so its recorded
// request set legitimately includes these three read operations in addition to
// its declared primary operation.
const DASHBOARD_READS = new Set([
  "GET /api/v1/status",
  "GET /api/v1/tasks",
  "GET /api/v1/reminders",
]);

const STATUS: SystemStatus = {
  status: "ok",
  version: "0.1.0",
  sourceVersion: "binding-test",
  provider: {
    name: "convex",
    reachability: "ok",
    authentication: "ok",
    schemaCompatibility: "compatible",
    deploymentVersion: "dev:outgoing-ram-798",
  },
  timezone: "Australia/Melbourne",
  layers: {
    runtime: { status: "ready" },
    domains: { status: "ready" },
    integration: { status: "ready" },
    orchestration: { status: "ready" },
    safety: { status: "ready" },
    adaptive: { status: "ready" },
    autonomy: { status: "ready" },
    reliability: { status: "ready" },
  },
  zState: "active",
  checkedAt: "2026-07-18T12:00:00.000Z",
};

function sampleTask(id = "task-1") {
  return { id, title: "Recorded task", completed: false, category: "builds", createdAt: 1 };
}

function sampleReminder(id = "reminder-1") {
  return { id, title: "Recorded reminder", dueRaw: "Friday 9am", createdAt: 1 };
}

/** Schema-valid mock responses so tool output validation never short-circuits a probe. */
function mockResponse(method: string, path: string): Response {
  if (path === "/api/v1/status") return Response.json(STATUS);
  if (path === "/api/v1/tasks") {
    return method === "POST"
      ? Response.json({ data: sampleTask() })
      : Response.json({ data: [sampleTask()], count: 1 });
  }
  if (/^\/api\/v1\/tasks\/[^/]+\/complete$/.test(path))
    return Response.json({ data: sampleTask() });
  if (/^\/api\/v1\/tasks\/[^/]+$/.test(path)) return Response.json({ data: sampleTask() });
  if (path === "/api/v1/reminders") {
    return method === "POST"
      ? Response.json({ data: sampleReminder() })
      : Response.json({ data: [sampleReminder()], count: 1 });
  }
  if (/^\/api\/v1\/reminders\/[^/]+$/.test(path)) return Response.json({ data: sampleReminder() });
  return Response.json({ title: "Not Found", status: 404 }, { status: 404 });
}

type RecordedRequest = { method: string; path: string; authorization: string | null };

function recordingFetch(records: RecordedRequest[]): typeof fetch {
  return (async (input: string | URL | Request, init?: RequestInit) => {
    const url = new URL(String(input));
    const method = (init?.method ?? "GET").toUpperCase();
    const headers = new Headers(init?.headers);
    records.push({ method, path: url.pathname, authorization: headers.get("authorization") });
    return mockResponse(method, url.pathname);
  }) as typeof fetch;
}

type OpenApiOperation = { method: string; regex: RegExp; key: string };

function escapeSegment(segment: string): string {
  return segment.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

/** Builds anchored, per-segment matchers from the OpenAPI templated operations. */
function openApiMatchers(): OpenApiOperation[] {
  const raw = readFileSync(new URL("../openapi/jarvis.openapi.json", import.meta.url), "utf8");
  const document = JSON.parse(raw) as { paths: Record<string, Record<string, unknown>> };
  const matchers: OpenApiOperation[] = [];
  for (const [path, item] of Object.entries(document.paths)) {
    const pattern = path
      .split("/")
      .map((segment) =>
        segment.startsWith("{") && segment.endsWith("}") ? "[^/]+" : escapeSegment(segment),
      )
      .join("/");
    const regex = new RegExp(`^${pattern}$`);
    for (const method of Object.keys(item)) {
      if (HTTP_METHODS.has(method)) {
        matchers.push({
          method: method.toUpperCase(),
          regex,
          key: `${method.toUpperCase()} ${path}`,
        });
      }
    }
  }
  return matchers;
}

/** Classifies a concrete recorded request to its templated OpenAPI operation key. */
function classify(matchers: OpenApiOperation[], request: RecordedRequest): string {
  const match = matchers.find(
    (candidate) => candidate.method === request.method && candidate.regex.test(request.path),
  );
  if (!match) {
    throw new Error(
      `MCP adapter issued ${request.method} ${request.path}, which is not in the OpenAPI contract.`,
    );
  }
  return match.key;
}

const TOOL_INVOCATIONS: Record<string, Record<string, unknown>> = {
  show_jarvis_dashboard: {},
  get_jarvis_status: {},
  list_tasks: {},
  get_task: { taskId: "task-1" },
  create_task: { title: "Recorded task" },
  update_task: { taskId: "task-1", title: "Renamed" },
  complete_task: { taskId: "task-1" },
  delete_task: { taskId: "task-1" },
  list_reminders: {},
  get_reminder: { reminderId: "reminder-1" },
  create_reminder: { title: "Recorded reminder" },
  update_reminder: { reminderId: "reminder-1", title: "Renamed" },
  delete_reminder: { reminderId: "reminder-1" },
};

describe("MCP tool operation bindings", () => {
  it("proves each tool calls exactly its declared operation (plus the dashboard refresh)", async () => {
    const matchers = openApiMatchers();
    const records: RecordedRequest[] = [];
    const apiClient = new JarvisApiClient(
      { baseUrl: new URL("http://127.0.0.1:3000/"), serviceToken: SERVICE_TOKEN },
      recordingFetch(records),
    );
    const server = createJarvisMcpServer(apiClient);
    const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
    const client = new Client({ name: "jarvis-binding-test", version: "0.1.0" });

    await server.connect(serverTransport);
    await client.connect(clientTransport);

    try {
      // Every registered tool must be declared, and vice versa (drift guard).
      const registered = (await client.listTools()).tools.map((tool) => tool.name).sort();
      assert.deepEqual(
        registered,
        Object.keys(MCP_TOOL_OPERATIONS).sort(),
        "The invocation table drifted from the registered MCP tool surface.",
      );

      for (const [tool, args] of Object.entries(TOOL_INVOCATIONS)) {
        records.length = 0;
        const result = await client.callTool({ name: tool, arguments: args });
        assert.notEqual(result.isError, true, `${tool} returned an error instead of a snapshot.`);
        assert.ok(records.length > 0, `${tool} issued no HTTP request.`);

        // Every request the adapter makes must be authenticated with the service token.
        for (const request of records) {
          assert.equal(
            request.authorization,
            `Bearer ${SERVICE_TOKEN}`,
            `${tool} issued an unauthenticated request to ${request.path}.`,
          );
        }

        const recorded = new Set(records.map((request) => classify(matchers, request)));
        const declared = new Set(MCP_TOOL_OPERATIONS[tool].map(formatOperation));
        const tolerated = new Set([...declared, ...DASHBOARD_READS]);

        // The declared primary operation(s) must actually be called...
        for (const operation of declared) {
          assert.ok(recorded.has(operation), `${tool} never called its declared ${operation}.`);
        }
        // ...and the tool must not reach any operation beyond its declaration + the refresh.
        for (const operation of recorded) {
          assert.ok(
            tolerated.has(operation),
            `${tool} called ${operation}, which is outside its declared contract.`,
          );
        }
      }
    } finally {
      await client.close();
      await server.close();
    }
  });
});
