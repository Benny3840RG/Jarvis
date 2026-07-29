import assert from "node:assert/strict";
import { createServer } from "node:net";
import { describe, it } from "node:test";

import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";

import type { DailyBrief } from "../src/briefs/brief.js";
import type { SystemStatus } from "../src/http/contracts.js";
import type { JarvisMcpConfig } from "../src/mcp/config.js";
import { startJarvisMcpHttpServer } from "../src/mcp/httpServer.js";
import { JarvisApiClient } from "../src/mcp/jarvisApiClient.js";
import { JARVIS_DASHBOARD_URI } from "../src/mcp/server.js";
import { AUTHORISED_DEVELOPMENT_DEPLOYMENT } from "../src/preview/paddock.js";
import {
  PADDOCK_DASHBOARD_MARKER,
  PADDOCK_DASHBOARD_MIME_TYPE,
  assertPaddockDashboardResource,
  assertPaddockDashboardSnapshot,
  assertRequiredPaddockTools,
  extractPaddockDashboardSnapshot,
} from "../src/preview/paddockProbe.js";

const STATUS: SystemStatus = {
  status: "ok",
  version: "0.1.0",
  sourceVersion: "paddock-probe-test",
  provider: {
    name: "convex",
    reachability: "ok",
    authentication: "ok",
    schemaCompatibility: "compatible",
    deploymentVersion: AUTHORISED_DEVELOPMENT_DEPLOYMENT,
  },
  reconciliation: { state: "disabled", enabled: false },
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

const BRIEF: DailyBrief = {
  generatedAt: "2026-07-30T00:00:00.000Z",
  timezone: "Australia/Melbourne",
  headline: "0 open tasks, 0 reminders due, 0 active projects, 0 quotes awaiting response.",
  tasks: { openCount: 0, completedCount: 0, open: [] },
  reminders: { dueCount: 0, upcomingCount: 0, undatedCount: 0, due: [], upcoming: [] },
  projects: {
    activeCount: 0,
    countsByStatus: { lead: 0, quoted: 0, active: 0, on_hold: 0, done: 0 },
    active: [],
  },
  quotes: {
    countsByStatus: { draft: 0, sent: 0, accepted: 0, declined: 0 },
    pipelineTotal: 0,
    acceptedTotal: 0,
    awaitingResponse: [],
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

function mockFetch(status: SystemStatus = STATUS): typeof fetch {
  return (async (input: string | URL | Request) => {
    const path = new URL(String(input)).pathname;
    if (path === "/api/v1/status") return Response.json(status);
    if (path === "/api/v1/tasks") return Response.json({ data: [], count: 0 });
    if (path === "/api/v1/reminders") return Response.json({ data: [], count: 0 });
    if (path === "/api/v1/brief") return Response.json({ data: BRIEF });
    return Response.json({ title: "Not Found", status: 404 }, { status: 404 });
  }) as typeof fetch;
}

describe("Jarvis paddock readiness probe", () => {
  it("accepts a live-shaped MCP preview end to end without a live deployment", async () => {
    const config: JarvisMcpConfig = {
      host: "127.0.0.1",
      port: await freePort(),
      api: {
        baseUrl: new URL("http://127.0.0.1:3000/"),
        serviceToken: "paddock-probe-token",
      },
    };
    const running = await startJarvisMcpHttpServer(
      config,
      new JarvisApiClient(config.api, mockFetch()),
    );
    const client = new Client({ name: "jarvis-paddock-probe-test", version: "0.1.0" });
    try {
      await client.connect(new StreamableHTTPClientTransport(new URL(running.url)));

      const toolList = await client.listTools();
      assert.doesNotThrow(() =>
        assertRequiredPaddockTools(toolList.tools.map((tool) => tool.name)),
      );

      const resource = await client.readResource({ uri: JARVIS_DASHBOARD_URI });
      assert.doesNotThrow(() => assertPaddockDashboardResource(resource.contents));

      const result = await client.callTool({ name: "show_jarvis_dashboard", arguments: {} });
      const reported = assertPaddockDashboardSnapshot(result, AUTHORISED_DEVELOPMENT_DEPLOYMENT);
      assert.equal(reported.provider.deploymentVersion, AUTHORISED_DEVELOPMENT_DEPLOYMENT);
    } finally {
      await client.close();
      await running.close();
    }
  });

  it("rejects a preview whose provider state drifts from the commissioned deployment", async () => {
    const drifted: SystemStatus = {
      ...STATUS,
      provider: { ...STATUS.provider, deploymentVersion: "dev:someone-elses-ram" },
    };
    const config: JarvisMcpConfig = {
      host: "127.0.0.1",
      port: await freePort(),
      api: { baseUrl: new URL("http://127.0.0.1:3000/"), serviceToken: "paddock-probe-token" },
    };
    const running = await startJarvisMcpHttpServer(
      config,
      new JarvisApiClient(config.api, mockFetch(drifted)),
    );
    const client = new Client({ name: "jarvis-paddock-probe-drift", version: "0.1.0" });
    try {
      await client.connect(new StreamableHTTPClientTransport(new URL(running.url)));
      const result = await client.callTool({ name: "show_jarvis_dashboard", arguments: {} });
      assert.throws(
        () => assertPaddockDashboardSnapshot(result, AUTHORISED_DEVELOPMENT_DEPLOYMENT),
        /reported deployment/,
      );
    } finally {
      await client.close();
      await running.close();
    }
  });

  it("requires every paddock tool to be present", () => {
    assert.doesNotThrow(() =>
      assertRequiredPaddockTools([
        "show_jarvis_dashboard",
        "get_jarvis_status",
        "list_tasks",
        "list_reminders",
      ]),
    );
    assert.throws(
      () =>
        assertRequiredPaddockTools(["show_jarvis_dashboard", "get_jarvis_status", "list_tasks"]),
      /Required MCP tool is missing: list_reminders/,
    );
  });

  it("rejects a dashboard resource that is missing, duplicated, or malformed", () => {
    const validWidget = {
      uri: JARVIS_DASHBOARD_URI,
      mimeType: PADDOCK_DASHBOARD_MIME_TYPE,
      text: `<h1>${PADDOCK_DASHBOARD_MARKER}</h1>`,
    };
    assert.doesNotThrow(() => assertPaddockDashboardResource([validWidget]));
    assert.throws(() => assertPaddockDashboardResource([]), /unavailable or invalid/);
    assert.throws(
      () => assertPaddockDashboardResource([validWidget, validWidget]),
      /unavailable or invalid/,
    );
    assert.throws(
      () => assertPaddockDashboardResource([{ ...validWidget, mimeType: "text/html" }]),
      /unavailable or invalid/,
    );
    assert.throws(
      () => assertPaddockDashboardResource([{ ...validWidget, text: "<h1>WRONG WIDGET</h1>" }]),
      /unavailable or invalid/,
    );
  });

  it("rejects tool results that are errors or lack structured content", () => {
    const snapshot = { status: STATUS, tasks: [], reminders: [], brief: BRIEF, counts: {} };
    assert.deepEqual(
      extractPaddockDashboardSnapshot({ content: [], structuredContent: snapshot }),
      snapshot,
    );
    assert.throws(() => extractPaddockDashboardSnapshot({}), /did not return a valid snapshot/);
    assert.throws(
      () =>
        extractPaddockDashboardSnapshot({
          content: [],
          isError: true,
          structuredContent: snapshot,
        }),
      /did not return a valid snapshot/,
    );
    assert.throws(
      () => extractPaddockDashboardSnapshot({ content: [] }),
      /did not return a valid snapshot/,
    );
  });
});
