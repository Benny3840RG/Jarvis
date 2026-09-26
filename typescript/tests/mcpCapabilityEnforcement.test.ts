import assert from "node:assert/strict";
import { describe, it } from "node:test";

import { McpCapabilityGuard, resolveMcpCapabilityGrant } from "../src/mcp/capabilityGuard.js";
import { resolveJarvisMcpConfig } from "../src/mcp/config.js";
import { bindCapabilityGuard } from "../src/mcp/guardedMcpServer.js";
import { grantableMcpTools } from "../src/mcp/capabilityGuard.js";
import type { McpServer } from "../src/mcp/sdkAdapter.js";

type ToolCallback = (...args: unknown[]) => unknown;

/** A minimal fake McpServer that records the callback each tool registers under. */
function fakeServer(): { server: McpServer; registered: Map<string, ToolCallback> } {
  const registered = new Map<string, ToolCallback>();
  const server = {
    registerTool(name: string, _config: unknown, cb: ToolCallback) {
      registered.set(name, cb);
      return {};
    },
  } as unknown as McpServer;
  return { server, registered };
}

describe("MCP capability enforcement wiring (PR E)", () => {
  it("refuses an ungranted tool's call and never runs its handler; allows a granted one", async () => {
    const { server, registered } = fakeServer();
    bindCapabilityGuard(server, new McpCapabilityGuard(["list_tasks"]));

    let grantedRan = false;
    let deniedRan = false;
    server.registerTool("list_tasks", {}, () => {
      grantedRan = true;
      return { content: [{ type: "text", text: "ok" }] };
    });
    server.registerTool("create_task", {}, () => {
      deniedRan = true;
      return { content: [{ type: "text", text: "should not run" }] };
    });

    const granted = (await registered.get("list_tasks")!({}, {})) as Record<string, unknown>;
    const denied = (await registered.get("create_task")!({}, {})) as Record<string, unknown>;

    assert.equal(grantedRan, true);
    assert.notEqual(granted.isError, true);

    // The denied tool's real handler never ran and the caller got an error result.
    assert.equal(deniedRan, false);
    assert.equal(denied.isError, true);
    assert.match(JSON.stringify(denied.content), /not in this session's capability grant/);
  });

  it("resolves an unset ceiling to the whole declared surface", () => {
    assert.deepEqual(resolveMcpCapabilityGrant(undefined), grantableMcpTools());
  });

  it("resolves a configured subset to exactly that subset, and rejects an unknown tool", () => {
    assert.deepEqual(resolveMcpCapabilityGrant(["get_task", "list_tasks", "get_task"]).sort(), [
      "get_task",
      "list_tasks",
    ]);
    assert.throws(
      () => resolveMcpCapabilityGrant(["list_tasks", "not_a_tool"]),
      /declared MCP surface/,
    );
  });

  it("parses JARVIS_MCP_CAPABILITIES into the config, or leaves it unset", () => {
    const base = {
      JARVIS_SERVICE_TOKEN: "service-token",
      JARVIS_MCP_HOST: "127.0.0.1",
    } satisfies NodeJS.ProcessEnv;
    assert.equal(resolveJarvisMcpConfig(base).capabilities, undefined);
    const configured = resolveJarvisMcpConfig({
      ...base,
      JARVIS_MCP_CAPABILITIES: " list_tasks , get_task ,list_tasks",
    });
    assert.deepEqual(configured.capabilities, ["list_tasks", "get_task"]);
  });
});
