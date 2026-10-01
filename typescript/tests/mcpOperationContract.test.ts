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

/** Operations whose `x-mcp-tool.exposed` flag is true in the OpenAPI contract. */
function openApiExposedOperations(): Set<string> {
  const raw = readFileSync(new URL("../openapi/jarvis.openapi.json", import.meta.url), "utf8");
  const document = JSON.parse(raw) as {
    paths: Record<string, Record<string, { "x-mcp-tool"?: { exposed?: boolean } }>>;
  };
  const operations = new Set<string>();
  for (const [path, item] of Object.entries(document.paths)) {
    for (const [method, operation] of Object.entries(item)) {
      if (HTTP_METHODS.has(method) && operation["x-mcp-tool"]?.exposed === true) {
        operations.add(`${method.toUpperCase()} ${path}`);
      }
    }
  }
  return operations;
}

/**
 * Pre-existing drift, recorded rather than silently fixed (issue #658): these
 * operations were wired to MCP tools (list_quotes, get_quote,
 * run_persistence_settings_action) while their OpenAPI flag stayed false.
 * Correcting their flags is an owner contract decision, so they are pinned
 * here and the test fails if either side changes, forcing the list to shrink.
 */
const LEGACY_UNMARKED = new Set([
  "GET /api/v1/quotes",
  "GET /api/v1/quotes/{quoteId}",
  "POST /api/v1/settings/persistence/actions",
]);

/**
 * Pre-existing idempotentHint drift between these tools and their OpenAPI
 * x-mcp-tool annotations (issue #658). Pinned, not fixed here: which side is
 * right is a contract decision, and the test fails once either side changes.
 */
const LEGACY_ANNOTATION_DRIFT = new Set([
  "create_task",
  "delete_task",
  "create_reminder",
  "delete_reminder",
]);

function openApiAnnotations(method: string, path: string): Record<string, boolean> {
  const raw = readFileSync(new URL("../openapi/jarvis.openapi.json", import.meta.url), "utf8");
  const document = JSON.parse(raw) as {
    paths: Record<
      string,
      Record<string, { "x-mcp-tool": { annotations: Record<string, boolean> } }>
    >;
  };
  return document.paths[path][method.toLowerCase()]["x-mcp-tool"].annotations;
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
  return (await registeredTools()).map((tool) => tool.name).sort();
}

async function registeredTools() {
  const config: JarvisMcpConfig = {
    host: "127.0.0.1",
    port: await freePort(),
    api: { baseUrl: new URL("http://127.0.0.1:3000/"), serviceToken: "contract-test-token" },
  };
  const running = await startJarvisMcpHttpServer(config, new JarvisApiClient(config.api));
  const client = new Client({ name: "jarvis-contract-test", version: "0.1.0" });
  try {
    await client.connect(new StreamableHTTPClientTransport(new URL(running.url)));
    return (await client.listTools()).tools;
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

  it("marks exactly the MCP-reached operations as x-mcp-tool exposed in OpenAPI", () => {
    const exposedInSpec = openApiExposedOperations();
    const reached = mcpExposedOperations();
    const unmarked = [...reached].filter(
      (operation) => !exposedInSpec.has(operation) && !LEGACY_UNMARKED.has(operation),
    );
    assert.deepEqual(
      unmarked,
      [],
      `MCP reaches operations the OpenAPI contract marks x-mcp-tool.exposed=false: ${unmarked.join(", ")}`,
    );
    const unreached = [...exposedInSpec].filter((operation) => !reached.has(operation));
    assert.deepEqual(
      unreached,
      [],
      `OpenAPI marks operations as MCP-exposed that no MCP tool reaches: ${unreached.join(", ")}`,
    );
    for (const operation of LEGACY_UNMARKED) {
      assert.ok(reached.has(operation), `${operation} is no longer reached; drop its exemption.`);
      assert.ok(!exposedInSpec.has(operation), `${operation} is now marked; drop its exemption.`);
    }
  });

  it("gives each single-operation tool the annotations its OpenAPI operation declares", async () => {
    const tools = await registeredTools();
    const mismatched: string[] = [];
    for (const tool of tools) {
      const operations = MCP_TOOL_OPERATIONS[tool.name];
      if (!operations || operations.length !== 1) continue;
      const declared = openApiAnnotations(operations[0].method, operations[0].path);
      const differs = Object.entries(declared).some(
        ([hint, value]) =>
          (tool.annotations as Record<string, unknown> | undefined)?.[hint] !== value,
      );
      if (differs && !LEGACY_ANNOTATION_DRIFT.has(tool.name)) mismatched.push(tool.name);
      if (!differs && LEGACY_ANNOTATION_DRIFT.has(tool.name)) {
        assert.fail(`${tool.name} now matches the contract; drop its drift exemption.`);
      }
    }
    assert.deepEqual(mismatched, [], `MCP tool annotations differ from OpenAPI: ${mismatched}`);
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
