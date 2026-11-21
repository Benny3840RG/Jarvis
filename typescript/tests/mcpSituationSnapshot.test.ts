import assert from "node:assert/strict";
import { it } from "node:test";

import { Client, InMemoryTransport } from "@modelcontextprotocol/client";

import type { JarvisMcpConfig } from "../src/mcp/config.js";
import { JarvisApiClient } from "../src/mcp/jarvisApiClient.js";
import { MCP_TOOL_OPERATIONS } from "../src/mcp/operationContract.js";
import { createJarvisMcpServer } from "../src/mcp/server.js";
import type { Task } from "../src/persistence/persistence.js";
import {
  composeSituationSnapshot,
  situationSnapshotSchema,
} from "../src/situation/situationSnapshot.js";

const NOW = Date.UTC(2026, 10, 17, 0, 42, 5);
const TOKEN = "private-service-token";

it("registers one read-only situation tool and returns the existing sourced snapshot", async () => {
  const tasks: Task[] = Array.from({ length: 7 }, (_, index) => ({
    id: `task-${index}`,
    title: `Task ${index}`,
    category: "work",
    completed: false,
    createdAt: 1,
    directCreateIdempotencyKey: "private-task-key",
  }));
  const mutations: string[] = [];
  const taskSource = {
    listTasks: async () => tasks,
    addTask: () => mutations.push("addTask"),
  };
  const approvalSource = {
    countProposed: async (): Promise<never> => {
      throw new Error("approval source unavailable");
    },
    stage: () => mutations.push("stage"),
    approve: () => mutations.push("approve"),
    reject: () => mutations.push("reject"),
  };
  const snapshot = await composeSituationSnapshot({
    now: () => NOW,
    timezone: "Australia/Melbourne",
    status: null,
    tasks: taskSource,
    reminders: null,
    projects: null,
    approvals: approvalSource,
    reconciliation: () => ({
      state: "running",
      enabled: true,
      freshnessMs: 60_000,
      lastSuccessfulCycleAt: new Date(NOW - 120_000).toISOString(),
      lastCycleOutcome: "success",
    }),
  });
  const config: JarvisMcpConfig = {
    host: "127.0.0.1",
    port: 8787,
    api: { baseUrl: new URL("http://127.0.0.1:3000/"), serviceToken: TOKEN },
  };
  const calls: string[] = [];
  const fetchFixture: typeof fetch = async (input, init) => {
    const path = new URL(String(input)).pathname;
    calls.push(`${init?.method} ${path}`);
    assert.equal(init?.method, "GET");
    assert.equal(path, "/api/v1/situation");
    assert.equal(new Headers(init.headers).get("authorization"), `Bearer ${TOKEN}`);
    assert.equal(init.body, undefined);
    return Response.json(snapshot);
  };
  const server = createJarvisMcpServer(new JarvisApiClient(config.api, fetchFixture));
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  const client = new Client({ name: "situation-contract-test", version: "0.1.0" });
  try {
    await server.connect(serverTransport);
    await client.connect(clientTransport);
    const tools = (await client.listTools()).tools;
    const tool = tools.find((entry) => entry.name === "get_situation_snapshot");
    assert.ok(tool, "the situation tool must be registered");
    assert.equal(tools.filter((entry) => entry.name.includes("situation")).length, 1);
    assert.equal(tool.annotations?.readOnlyHint, true);
    assert.equal(tool.annotations?.destructiveHint, false);
    assert.ok(tool.outputSchema);
    assert.ok(JSON.stringify(tool.outputSchema).includes("openTasks"));
    assert.deepEqual(MCP_TOOL_OPERATIONS.get_situation_snapshot, [
      { method: "GET", path: "/api/v1/situation" },
    ]);

    const first = await client.callTool({ name: tool.name, arguments: {} });
    const second = await client.callTool({ name: tool.name, arguments: {} });
    assert.equal(first.isError, undefined);
    assert.deepEqual(first.structuredContent, snapshot);
    assert.deepEqual(second.structuredContent, first.structuredContent);
    assert.deepEqual(situationSnapshotSchema.parse(first.structuredContent), snapshot);
    assert.equal(snapshot.fields.systemHealth.status, "unavailable");
    assert.equal(snapshot.fields.pendingApprovals.status, "unavailable");
    assert.equal(snapshot.fields.calendar.status, "unknown");
    assert.equal(snapshot.fields.presence.status, "unknown");
    assert.equal(snapshot.fields.devices.status, "unknown");
    assert.equal(snapshot.fields.reconciliation.freshness, "stale");
    assert.equal(snapshot.fields.reconciliation.observedAt, new Date(NOW - 120_000).toISOString());
    assert.deepEqual(snapshot.fields.openTasks.value, {
      count: 7,
      titles: ["Task 0", "Task 1", "Task 2", "Task 3", "Task 4"],
    });
    for (const key of [
      "systemHealth",
      "pendingApprovals",
      "calendar",
      "presence",
      "devices",
    ] as const) {
      const field = snapshot.fields[key];
      assert.ok(field.reason);
      assert.equal(field.freshness, "unknown");
      assert.equal(field.observedAt, null);
      assert.equal("value" in field, false);
    }
    assert.equal(JSON.stringify(first).includes(TOKEN), false);
    assert.equal(JSON.stringify(first).includes("private-task-key"), false);
    assert.deepEqual(calls, ["GET /api/v1/situation", "GET /api/v1/situation"]);
    assert.deepEqual(mutations, []);
  } finally {
    await client.close();
    await server.close();
  }
});
