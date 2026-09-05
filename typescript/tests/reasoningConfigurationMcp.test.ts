import assert from "node:assert/strict";
import { describe, it } from "node:test";

import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";

import type { ReasoningConfigurationStatus, SystemStatus } from "../src/http/contracts.js";
import { JarvisApiClient } from "../src/mcp/jarvisApiClient.js";
import { createJarvisMcpServer } from "../src/mcp/server.js";

function statusWithReasoning(reasoning: ReasoningConfigurationStatus): SystemStatus {
  return {
    status: "ok",
    version: "0.1.0",
    sourceVersion: "reasoning-mcp-test",
    provider: {
      name: "convex",
      reachability: "ok",
      authentication: "ok",
      schemaCompatibility: "compatible",
      deploymentVersion: "dev:reasoning-mcp-test",
    },
    reconciliation: { state: "disabled", enabled: false },
    integrations: [],
    reasoning,
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
}

async function fetchStatusThroughMcp(status: SystemStatus) {
  const fetchImpl = (async (input: string | URL | Request) => {
    const path = new URL(String(input)).pathname;
    if (path === "/api/v1/status") return Response.json(status);
    return Response.json({ title: "Not Found", status: 404 }, { status: 404 });
  }) as typeof fetch;
  const apiClient = new JarvisApiClient(
    { baseUrl: new URL("https://jarvis.example/"), serviceToken: "reasoning-mcp-test-token" },
    fetchImpl,
  );
  const server = createJarvisMcpServer(apiClient);
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  const client = new Client({ name: "reasoning-mcp-test", version: "0.1.0" });

  await server.connect(serverTransport);
  await client.connect(clientTransport);
  try {
    return await client.callTool({ name: "get_jarvis_status", arguments: {} });
  } finally {
    await client.close();
    await server.close();
  }
}

describe("MCP status schema carries the reasoning configuration projection", () => {
  it("passes a configured reasoning identity through the existing statusSchema without a parallel schema", async () => {
    const configured: ReasoningConfigurationStatus = {
      status: "configured",
      provider: "openai",
      model: "gpt-5.6-terra",
      observability: "configuration-only",
    };
    const result = await fetchStatusThroughMcp(statusWithReasoning(configured));

    assert.equal(result.isError, undefined);
    assert.deepEqual(
      (result.structuredContent as { status: SystemStatus }).status.reasoning,
      configured,
    );
  });

  it("passes a not-configured reasoning projection through the existing statusSchema", async () => {
    const notConfigured: ReasoningConfigurationStatus = {
      status: "not-configured",
      reason: "OpenAI reasoning credentials are not configured.",
    };
    const result = await fetchStatusThroughMcp(statusWithReasoning(notConfigured));

    assert.equal(result.isError, undefined);
    assert.deepEqual(
      (result.structuredContent as { status: SystemStatus }).status.reasoning,
      notConfigured,
    );
  });
});
