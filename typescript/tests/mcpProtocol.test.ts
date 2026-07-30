import assert from "node:assert/strict";
import { createServer } from "node:net";
import { describe, it } from "node:test";

import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";

import type { SystemStatus } from "../src/http/contracts.js";
import type { JarvisMcpConfig } from "../src/mcp/config.js";
import { startJarvisMcpHttpServer } from "../src/mcp/httpServer.js";
import { JarvisApiClient } from "../src/mcp/jarvisApiClient.js";
import { JARVIS_DASHBOARD_URI } from "../src/mcp/server.js";

const STATUS: SystemStatus = {
  status: "ok",
  version: "0.1.0",
  sourceVersion: "preview-test",
  provider: {
    name: "convex",
    reachability: "ok",
    authentication: "ok",
    schemaCompatibility: "compatible",
    deploymentVersion: "dev:outgoing-ram-798",
  },
  reconciliation: { state: "disabled", enabled: false },
  integrations: [],
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

const BRIEF = {
  generatedAt: "2026-07-30T00:00:00.000Z",
  timezone: "Australia/Melbourne",
  headline: "1 open task, 0 reminders due, 1 active project, 1 quote awaiting response.",
  tasks: {
    openCount: 1,
    completedCount: 0,
    open: [
      {
        id: "task-preview-1",
        title: "Inspect Jarvis preview",
        completed: false,
        category: "builds",
        createdAt: 1,
      },
    ],
  },
  reminders: { dueCount: 0, upcomingCount: 0, undatedCount: 1, due: [], upcoming: [] },
  projects: {
    activeCount: 1,
    countsByStatus: { lead: 0, quoted: 0, active: 1, on_hold: 0, done: 0 },
    active: [
      {
        id: "project-preview-1",
        clientId: "client-preview-1",
        title: "Frankston garden rebuild",
        status: "active",
        createdAt: 1,
        updatedAt: 2,
      },
    ],
  },
  quotes: {
    countsByStatus: { draft: 0, sent: 1, accepted: 0, declined: 0 },
    pipelineTotal: 3200,
    acceptedTotal: 0,
    awaitingResponse: [
      {
        id: "quote-preview-1",
        clientId: "client-preview-1",
        projectId: "project-preview-1",
        number: "174",
        status: "sent",
        lineItems: [{ description: "Garden works", quantity: 1, unitPrice: 3200 }],
        subtotal: 3200,
        tax: 0,
        total: 3200,
        createdAt: 1,
        updatedAt: 2,
      },
    ],
    drafts: [],
  },
  maintenance: { dueCount: 0, dueSoonCount: 0, due: [], dueSoon: [] },
};

async function freePort(): Promise<number> {
  const server = createServer();
  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", resolve);
  });
  const address = server.address();
  const port = typeof address === "object" && address ? address.port : 0;
  await new Promise<void>((resolve, reject) => {
    server.close((error) => (error ? reject(error) : resolve()));
  });
  return port;
}

function mockFetch(): typeof fetch {
  return (async (input: string | URL | Request) => {
    const path = new URL(String(input)).pathname;
    if (path === "/api/v1/status") return Response.json(STATUS);
    if (path === "/api/v1/tasks") {
      return Response.json({
        data: [
          {
            id: "task-preview-1",
            title: "Inspect Jarvis preview",
            completed: false,
            category: "builds",
            createdAt: 1,
          },
        ],
        count: 1,
      });
    }
    if (path === "/api/v1/brief") return Response.json({ data: BRIEF });
    if (path === "/api/v1/quotes") return Response.json({ data: [], count: 0 });
    if (path === "/api/v1/reminders") {
      return Response.json({
        data: [
          {
            id: "reminder-preview-1",
            title: "Review preview verdict",
            dueRaw: "Friday 9am",
            createdAt: 1,
          },
        ],
        count: 1,
      });
    }
    return Response.json(
      {
        type: "urn:jarvis:problem:not-found",
        title: "Not Found",
        status: 404,
        detail: "The requested resource does not exist.",
        requestId: "preview-test-request",
      },
      { status: 404 },
    );
  }) as typeof fetch;
}

describe("Jarvis MCP preview protocol", () => {
  it("initialises, lists tools, calls the dashboard and serves the widget resource", async () => {
    const config: JarvisMcpConfig = {
      host: "127.0.0.1",
      port: await freePort(),
      api: {
        baseUrl: new URL("http://127.0.0.1:3000/"),
        serviceToken: "preview-test-token",
      },
    };
    const running = await startJarvisMcpHttpServer(
      config,
      new JarvisApiClient(config.api, mockFetch()),
    );
    const client = new Client({ name: "jarvis-preview-test", version: "0.1.0" });
    try {
      await client.connect(new StreamableHTTPClientTransport(new URL(running.url)));

      const tools = await client.listTools();
      const names = tools.tools.map((tool) => tool.name);
      assert.ok(names.includes("show_jarvis_dashboard"));
      assert.ok(names.includes("create_task"));
      assert.ok(names.includes("create_reminder"));
      assert.ok(names.includes("delete_task"));
      assert.ok(names.includes("list_quotes"));
      assert.ok(names.includes("get_quote"));

      const result = await client.callTool({
        name: "show_jarvis_dashboard",
        arguments: {},
      });
      assert.equal(result.isError, undefined);
      assert.deepEqual(result.structuredContent, {
        status: STATUS,
        tasks: [
          {
            id: "task-preview-1",
            title: "Inspect Jarvis preview",
            completed: false,
            category: "builds",
            createdAt: 1,
          },
        ],
        reminders: [
          {
            id: "reminder-preview-1",
            title: "Review preview verdict",
            dueRaw: "Friday 9am",
            createdAt: 1,
          },
        ],
        brief: BRIEF,
        quoteRegister: { status: "ready", quotes: [] },
        inbox: null,
        activity: null,
        counts: {
          activeTasks: 1,
          completedTasks: 0,
          reminders: 1,
        },
      });

      const resource = await client.readResource({ uri: JARVIS_DASHBOARD_URI });
      assert.equal(resource.contents.length, 1);
      const widget = resource.contents[0];
      assert.equal(widget?.uri, JARVIS_DASHBOARD_URI);
      assert.equal(widget?.mimeType, "text/html;profile=mcp-app");
      assert.ok(widget && "text" in widget);
      assert.match(widget.text, /JARVIS \/\/ OPERATOR CONSOLE/);
    } finally {
      await client.close();
      await running.close();
    }
  });
});
