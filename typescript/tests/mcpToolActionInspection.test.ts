import assert from "node:assert/strict";
import { describe, it } from "node:test";

import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";

import { JarvisApiClient } from "../src/mcp/jarvisApiClient.js";
import { createJarvisMcpServer } from "../src/mcp/server.js";

const PROPOSED_ACTION = {
  actionId: "action-1",
  requestId: "request-1",
  projectId: "project-1",
  baseRevision: 3,
  state: "proposed",
  tool: "notes",
  operation: "create",
  arguments: { title: "Compressor repair notes" },
  rationale: "Log the repair for the maintenance history.",
  requiredAuthority: "T2",
  destructive: false,
  idempotencyKey: "request-1:notes-create",
  proposedBy: "agent",
  createdAt: "2026-07-30T00:00:00.000Z",
  updatedAt: "2026-07-30T00:00:00.000Z",
};

const APPROVED_ACTION = {
  ...PROPOSED_ACTION,
  actionId: "action-2",
  state: "approved",
  approvedBy: "user",
  approvedAt: "2026-07-30T00:05:00.000Z",
  updatedAt: "2026-07-30T00:05:00.000Z",
  approvalExpiryPolicy: "ttl",
  approvalExpiresAt: "2026-07-30T04:05:00.000Z",
  consumptionPolicy: "reusable",
  isApprovalExpired: false,
};

describe("MCP tool-action consent-lifecycle inspection (read-only)", () => {
  it("reads tool-action proposals and one action by id through the JarvisApiClient", async () => {
    const paths: string[] = [];
    const fetchImpl = (async (input: string | URL | Request) => {
      const url = new URL(String(input));
      paths.push(url.pathname + url.search);
      if (url.pathname === "/api/v1/projects/project-1/tool-actions") {
        return Response.json([PROPOSED_ACTION, APPROVED_ACTION]);
      }
      if (url.pathname === "/api/v1/projects/project-1/tool-actions/action-2") {
        return Response.json(APPROVED_ACTION);
      }
      return Response.json({ title: "Not Found", status: 404 }, { status: 404 });
    }) as typeof fetch;
    const client = new JarvisApiClient(
      { baseUrl: new URL("https://jarvis.example/"), serviceToken: "tool-action-inspection-test" },
      fetchImpl,
    );

    const listed = await client.listToolActions("project-1");
    const fetched = await client.getToolAction("project-1", "action-2");

    assert.deepEqual(listed, [PROPOSED_ACTION, APPROVED_ACTION]);
    assert.deepEqual(fetched, APPROVED_ACTION);
    assert.deepEqual(paths, [
      "/api/v1/projects/project-1/tool-actions",
      "/api/v1/projects/project-1/tool-actions/action-2",
    ]);
  });

  it("exposes tool-action inspection as read-only MCP tools that cannot approve, revoke, or execute", async () => {
    const fetchImpl = (async (input: string | URL | Request) => {
      const url = new URL(String(input));
      if (url.pathname === "/api/v1/projects/project-1/tool-actions") {
        return Response.json([PROPOSED_ACTION, APPROVED_ACTION]);
      }
      if (url.pathname === "/api/v1/projects/project-1/tool-actions/action-2") {
        return Response.json(APPROVED_ACTION);
      }
      return Response.json({ title: "Not Found", status: 404 }, { status: 404 });
    }) as typeof fetch;
    const apiClient = new JarvisApiClient(
      { baseUrl: new URL("https://jarvis.example/"), serviceToken: "tool-action-inspection-test" },
      fetchImpl,
    );
    const server = createJarvisMcpServer(apiClient);
    const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
    const client = new Client({ name: "tool-action-inspection-test", version: "0.1.0" });

    await server.connect(serverTransport);
    await client.connect(clientTransport);
    try {
      const catalogue = await client.listTools();
      const listTool = catalogue.tools.find((tool) => tool.name === "list_tool_actions");
      const getTool = catalogue.tools.find((tool) => tool.name === "get_tool_action");

      assert.ok(listTool, "list_tool_actions must be registered");
      assert.ok(getTool, "get_tool_action must be registered");
      for (const tool of [listTool, getTool]) {
        assert.equal(tool.annotations?.readOnlyHint, true, `${tool.name} must be read-only`);
        assert.equal(tool.annotations?.destructiveHint, false);
      }

      // Explicit non-exposure: no MCP tool anywhere may approve, revoke, or
      // execute a tool action, or expose an unrestricted generic executor.
      const forbiddenNamePattern = /^(approve|revoke|reject|execute)_tool_action$|^execute$/;
      assert.equal(
        catalogue.tools.some((tool) => forbiddenNamePattern.test(tool.name)),
        false,
        "no MCP tool may approve, revoke, reject, or execute a tool action",
      );
      assert.equal(
        catalogue.tools.some((tool) => /^finalize_quote|^send_quote/.test(tool.name)),
        false,
      );

      const listed = await client.callTool({
        name: "list_tool_actions",
        arguments: { projectId: "project-1" },
      });
      assert.equal(listed.isError, undefined);
      assert.deepEqual(listed.structuredContent, {
        actions: [PROPOSED_ACTION, APPROVED_ACTION],
        count: 2,
      });

      const inspected = await client.callTool({
        name: "get_tool_action",
        arguments: { projectId: "project-1", actionId: "action-2" },
      });
      assert.equal(inspected.isError, undefined);
      assert.deepEqual(inspected.structuredContent, { action: APPROVED_ACTION });
    } finally {
      await client.close();
      await server.close();
    }
  });

  it("reports a not-found tool action as a tool error rather than throwing", async () => {
    const fetchImpl = (async () =>
      Response.json(
        { type: "urn:jarvis:problem:tool-action-not-found", title: "Not Found", status: 404 },
        { status: 404 },
      )) as typeof fetch;
    const apiClient = new JarvisApiClient(
      { baseUrl: new URL("https://jarvis.example/"), serviceToken: "tool-action-inspection-test" },
      fetchImpl,
    );
    const server = createJarvisMcpServer(apiClient);
    const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
    const client = new Client({ name: "tool-action-not-found-test", version: "0.1.0" });

    await server.connect(serverTransport);
    await client.connect(clientTransport);
    try {
      const result = await client.callTool({
        name: "get_tool_action",
        arguments: { projectId: "project-1", actionId: "missing" },
      });
      assert.equal(result.isError, true);
    } finally {
      await client.close();
      await server.close();
    }
  });
});
