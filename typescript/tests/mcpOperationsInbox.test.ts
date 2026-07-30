import assert from "node:assert/strict";
import { describe, it } from "node:test";

import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";

import { JarvisApiClient } from "../src/mcp/jarvisApiClient.js";
import { createJarvisMcpServer } from "../src/mcp/server.js";

const INBOX = {
  generatedAt: "2026-07-30T12:00:00.000Z",
  items: [
    {
      itemId: "maintenance-overdue:asset-1",
      kind: "maintenance-overdue",
      severity: "elevated",
      title: "Bandsaw",
      explanation: "Service was due 2026-07-20T00:00:00.000Z and has not been recorded since.",
      sourceSubsystem: "maintenance",
      sourceRecordId: "asset-1",
      createdAt: "2026-01-01T00:00:00.000Z",
      dueAt: "2026-07-20T00:00:00.000Z",
      updatedAt: "2026-07-20T00:00:00.000Z",
      status: "overdue",
      actionRequired: true,
    },
  ],
  sources: [
    { source: "reminders", status: "available", checkedAt: "2026-07-30T12:00:00.000Z" },
    { source: "maintenance", status: "available", checkedAt: "2026-07-30T12:00:00.000Z" },
    {
      source: "toolActions",
      status: "unsupported",
      reason: "Not yet wired.",
      checkedAt: "2026-07-30T12:00:00.000Z",
    },
    {
      source: "reconciliation",
      status: "unsupported",
      reason: "Not yet wired.",
      checkedAt: "2026-07-30T12:00:00.000Z",
    },
    {
      source: "quoteDelivery",
      status: "unsupported",
      reason: "Not yet wired.",
      checkedAt: "2026-07-30T12:00:00.000Z",
    },
  ],
};

describe("MCP operations inbox inspection (read-only)", () => {
  it("reads the operations inbox through the JarvisApiClient", async () => {
    const paths: string[] = [];
    const fetchImpl = (async (input: string | URL | Request) => {
      const url = new URL(String(input));
      paths.push(url.pathname);
      if (url.pathname === "/api/v1/operations/inbox") {
        return Response.json({ data: INBOX });
      }
      return Response.json({ title: "Not Found", status: 404 }, { status: 404 });
    }) as typeof fetch;
    const client = new JarvisApiClient(
      { baseUrl: new URL("https://jarvis.example/"), serviceToken: "operations-inbox-test" },
      fetchImpl,
    );

    const inbox = await client.getOperationsInbox();

    assert.deepEqual(inbox, INBOX);
    assert.deepEqual(paths, ["/api/v1/operations/inbox"]);
  });

  it("exposes the operations inbox as a read-only MCP tool with no mutation counterpart", async () => {
    const fetchImpl = (async () => Response.json({ data: INBOX })) as typeof fetch;
    const apiClient = new JarvisApiClient(
      { baseUrl: new URL("https://jarvis.example/"), serviceToken: "operations-inbox-test" },
      fetchImpl,
    );
    const server = createJarvisMcpServer(apiClient);
    const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
    const client = new Client({ name: "operations-inbox-test", version: "0.1.0" });

    await server.connect(serverTransport);
    await client.connect(clientTransport);
    try {
      const catalogue = await client.listTools();
      const tool = catalogue.tools.find((entry) => entry.name === "get_operations_inbox");

      assert.ok(tool, "get_operations_inbox must be registered");
      assert.equal(tool.annotations?.readOnlyHint, true);
      assert.equal(tool.annotations?.destructiveHint, false);

      // No consequential tool anywhere may have snuck in alongside this one.
      const forbiddenNamePattern = /^(dismiss|acknowledge|resolve|approve|revoke|execute)_/i;
      assert.equal(
        catalogue.tools.some((entry) => forbiddenNamePattern.test(entry.name)),
        false,
        "no MCP tool may dismiss, acknowledge, resolve, approve, revoke, or execute an inbox item",
      );

      const result = await client.callTool({ name: "get_operations_inbox", arguments: {} });
      assert.equal(result.isError, undefined);
      assert.deepEqual(result.structuredContent, { inbox: INBOX });
    } finally {
      await client.close();
      await server.close();
    }
  });

  it("never claims a degraded or unsupported source is healthy", async () => {
    const fetchImpl = (async () => Response.json({ data: INBOX })) as typeof fetch;
    const apiClient = new JarvisApiClient(
      { baseUrl: new URL("https://jarvis.example/"), serviceToken: "operations-inbox-test" },
      fetchImpl,
    );
    const server = createJarvisMcpServer(apiClient);
    const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
    const client = new Client({ name: "operations-inbox-health-test", version: "0.1.0" });

    await server.connect(serverTransport);
    await client.connect(clientTransport);
    try {
      const result = await client.callTool({ name: "get_operations_inbox", arguments: {} });
      const structured = result.structuredContent as { inbox: typeof INBOX };
      const unsupported = structured.inbox.sources.filter(
        (entry) => entry.source !== "reminders" && entry.source !== "maintenance",
      );
      for (const source of unsupported) {
        assert.equal(source.status, "unsupported");
      }
    } finally {
      await client.close();
      await server.close();
    }
  });
});
