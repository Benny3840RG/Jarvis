import assert from "node:assert/strict";
import { describe, it } from "node:test";

import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";

import { JarvisApiClient } from "../src/mcp/jarvisApiClient.js";
import { createJarvisMcpServer } from "../src/mcp/server.js";

const AVAILABLE_ACTIVITY = {
  status: "available",
  events: [
    {
      activityId: "audit-1",
      occurredAt: "2026-07-30T10:00:00.000Z",
      eventType: "tool.action.approved",
      actor: "user",
      summary: "Tool action action-1 approved.",
      projectKey: "project-1",
    },
  ],
  cursor: "next-cursor",
  isDone: false,
};

const UNAVAILABLE_ACTIVITY = {
  status: "unavailable",
  reason: "The operations activity timeline requires the configured Convex persistence provider.",
};

describe("MCP activity timeline inspection (read-only)", () => {
  it("reads the activity timeline through the JarvisApiClient, forwarding cursor and limit", async () => {
    const requests: URL[] = [];
    const fetchImpl = (async (input: string | URL | Request) => {
      const url = new URL(String(input));
      requests.push(url);
      return Response.json({ data: AVAILABLE_ACTIVITY });
    }) as typeof fetch;
    const client = new JarvisApiClient(
      { baseUrl: new URL("https://jarvis.example/"), serviceToken: "activity-test" },
      fetchImpl,
    );

    const activity = await client.getOperationsActivity({ cursor: "prev-cursor", limit: 10 });

    assert.deepEqual(activity, AVAILABLE_ACTIVITY);
    assert.equal(requests.length, 1);
    assert.equal(requests[0]?.pathname, "/api/v1/operations/activity");
    assert.equal(requests[0]?.searchParams.get("cursor"), "prev-cursor");
    assert.equal(requests[0]?.searchParams.get("limit"), "10");
  });

  it("omits cursor and limit from the query string when not supplied", async () => {
    const requests: URL[] = [];
    const fetchImpl = (async (input: string | URL | Request) => {
      requests.push(new URL(String(input)));
      return Response.json({ data: AVAILABLE_ACTIVITY });
    }) as typeof fetch;
    const client = new JarvisApiClient(
      { baseUrl: new URL("https://jarvis.example/"), serviceToken: "activity-test" },
      fetchImpl,
    );

    await client.getOperationsActivity();

    assert.equal(requests[0]?.search, "");
  });

  it("exposes the activity timeline as a read-only MCP tool with no mutation counterpart", async () => {
    const fetchImpl = (async () => Response.json({ data: AVAILABLE_ACTIVITY })) as typeof fetch;
    const apiClient = new JarvisApiClient(
      { baseUrl: new URL("https://jarvis.example/"), serviceToken: "activity-test" },
      fetchImpl,
    );
    const server = createJarvisMcpServer(apiClient);
    const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
    const client = new Client({ name: "activity-timeline-test", version: "0.1.0" });

    await server.connect(serverTransport);
    await client.connect(clientTransport);
    try {
      const catalogue = await client.listTools();
      const tool = catalogue.tools.find((entry) => entry.name === "list_activity");

      assert.ok(tool, "list_activity must be registered");
      assert.equal(tool.annotations?.readOnlyHint, true);
      assert.equal(tool.annotations?.destructiveHint, false);

      const forbiddenNamePattern = /^(dismiss|acknowledge|resolve|approve|revoke|execute)_/i;
      assert.equal(
        catalogue.tools.some((entry) => forbiddenNamePattern.test(entry.name)),
        false,
        "no MCP tool may dismiss, acknowledge, resolve, approve, revoke, or execute an activity event",
      );

      const result = await client.callTool({ name: "list_activity", arguments: {} });
      assert.equal(result.isError, undefined);
      assert.deepEqual(result.structuredContent, { activity: AVAILABLE_ACTIVITY });
    } finally {
      await client.close();
      await server.close();
    }
  });

  it("rejects an out-of-range limit at the tool boundary before any HTTP call is made", async () => {
    let called = false;
    const fetchImpl = (async () => {
      called = true;
      return Response.json({ data: AVAILABLE_ACTIVITY });
    }) as typeof fetch;
    const apiClient = new JarvisApiClient(
      { baseUrl: new URL("https://jarvis.example/"), serviceToken: "activity-test" },
      fetchImpl,
    );
    const server = createJarvisMcpServer(apiClient);
    const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
    const client = new Client({ name: "activity-timeline-validation-test", version: "0.1.0" });

    await server.connect(serverTransport);
    await client.connect(clientTransport);
    try {
      const result = await client.callTool({ name: "list_activity", arguments: { limit: 500 } });
      assert.equal(result.isError, true);
      assert.equal(called, false);
    } finally {
      await client.close();
      await server.close();
    }
  });

  it("surfaces unavailability truthfully rather than an empty page", async () => {
    const fetchImpl = (async () => Response.json({ data: UNAVAILABLE_ACTIVITY })) as typeof fetch;
    const apiClient = new JarvisApiClient(
      { baseUrl: new URL("https://jarvis.example/"), serviceToken: "activity-test" },
      fetchImpl,
    );
    const server = createJarvisMcpServer(apiClient);
    const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
    const client = new Client({ name: "activity-timeline-unavailable-test", version: "0.1.0" });

    await server.connect(serverTransport);
    await client.connect(clientTransport);
    try {
      const result = await client.callTool({ name: "list_activity", arguments: {} });
      assert.equal(result.isError, undefined);
      assert.deepEqual(result.structuredContent, { activity: UNAVAILABLE_ACTIVITY });
      const text = (result.content as Array<{ type: string; text?: string }>)
        .map((entry) => entry.text ?? "")
        .join(" ");
      assert.match(text, /unavailable/i);
    } finally {
      await client.close();
      await server.close();
    }
  });
});
