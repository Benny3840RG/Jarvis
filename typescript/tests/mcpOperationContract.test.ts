import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { createServer } from "node:net";
import { describe, it } from "node:test";

import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";

import type { JarvisMcpConfig } from "../src/mcp/config.js";
import { startJarvisMcpHttpServer } from "../src/mcp/httpServer.js";
import { JarvisApiClient } from "../src/mcp/jarvisApiClient.js";
import { MCP_TOOL_OPERATIONS, mcpExposedOperations } from "../src/mcp/operationContract.js";

const HTTP_METHODS = new Set(["get", "post", "put", "patch", "delete"]);

function openApiOperations(): Set<string> {
  const raw = readFileSync(new URL("../openapi/jarvis.openapi.json", import.meta.url), "utf8");
  const document = JSON.parse(raw) as { paths: Record<string, Record<string, unknown>> };
  const operations = new Set<string>();
  for (const [path, item] of Object.entries(document.paths)) {
    for (const method of Object.keys(item)) {
      if (HTTP_METHODS.has(method)) operations.add(`${method.toUpperCase()} ${path}`);
    }
  }
  return operations;
}

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

async function registeredToolNames(): Promise<string[]> {
  const config: JarvisMcpConfig = {
    host: "127.0.0.1",
    port: await freePort(),
    api: { baseUrl: new URL("http://127.0.0.1:3000/"), serviceToken: "contract-test-token" },
  };
  const running = await startJarvisMcpHttpServer(config, new JarvisApiClient(config.api));
  const client = new Client({ name: "jarvis-contract-test", version: "0.1.0" });
  try {
    await client.connect(new StreamableHTTPClientTransport(new URL(running.url)));
    const toolList = await client.listTools();
    return toolList.tools.map((tool) => tool.name).sort();
  } finally {
    await client.close();
    await running.close();
  }
}

describe("MCP operation contract", () => {
  it("declares an operation mapping for exactly the registered MCP tools", async () => {
    const registered = await registeredToolNames();
    const declared = Object.keys(MCP_TOOL_OPERATIONS).sort();
    assert.deepEqual(
      registered,
      declared,
      "MCP tool surface drifted from the declared operation contract; update src/mcp/operationContract.ts.",
    );
  });

  it("keeps every MCP-exposed operation within the OpenAPI contract", () => {
    const documented = openApiOperations();
    const missing = [...mcpExposedOperations()].filter((operation) => !documented.has(operation));
    assert.deepEqual(
      missing,
      [],
      `MCP adapter references operations absent from openapi/jarvis.openapi.json: ${missing.join(", ")}`,
    );
  });

  it("remains a strict subset of the documented operator API", () => {
    const documented = openApiOperations();
    const exposed = mcpExposedOperations();
    for (const operation of exposed) assert.ok(documented.has(operation));
    // The HTTP API intentionally documents operations the MCP adapter does not expose
    // (help, totality, memory change sets, tool actions, backups, conversations, health).
    assert.ok(
      exposed.size < documented.size,
      "MCP adapter is expected to expose a proper subset of the OpenAPI operations.",
    );
  });
});
