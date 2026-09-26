import assert from "node:assert/strict";
import { describe, it } from "node:test";

import {
  grantableMcpTools,
  isGrantableMcpTool,
  McpCapabilityGuard,
  McpCapabilityGuardError,
} from "../src/mcp/capabilityGuard.js";
import { MCP_TOOL_OPERATIONS } from "../src/mcp/operationContract.js";

describe("McpCapabilityGuard", () => {
  it("allows a granted tool and denies a known tool outside the grant", () => {
    const guard = new McpCapabilityGuard(["list_tasks", "get_task"]);
    assert.deepEqual(guard.decide("list_tasks"), { allowed: true });
    assert.equal(guard.allows("get_task"), true);
    // create_task exists in the surface but was not granted.
    assert.deepEqual(guard.decide("create_task"), { allowed: false, reason: "not-granted" });
    assert.equal(guard.allows("create_task"), false);
  });

  it("denies an empty grant everything (fail closed)", () => {
    const guard = new McpCapabilityGuard([]);
    for (const tool of grantableMcpTools()) {
      assert.equal(guard.allows(tool), false, tool);
    }
  });

  it("does not let the grantable surface be mutated at runtime", () => {
    // grantableMcpTools returns a copy; mutating it must not change membership,
    // and there is no exported Set to .add()/.clear() the real surface.
    const before = grantableMcpTools();
    const snapshot = [...before];
    before.push("smuggled_tool");
    before.length = 0;
    assert.equal(isGrantableMcpTool("smuggled_tool"), false);
    assert.deepEqual(grantableMcpTools(), snapshot);
    // A grant still cannot name the smuggled tool.
    assert.throws(() => new McpCapabilityGuard(["smuggled_tool"]), McpCapabilityGuardError);
  });

  it("denies a tool that is not part of the MCP surface as unknown", () => {
    const guard = new McpCapabilityGuard(["list_tasks"]);
    for (const tool of ["", "list_tasks ", "LIST_TASKS", "totally_made_up"]) {
      assert.deepEqual(guard.decide(tool), { allowed: false, reason: "unknown-tool" }, tool);
    }
  });

  it("refuses to construct a grant naming a tool outside the MCP surface", () => {
    // An authority operation is not an MCP tool, so it cannot even be granted.
    for (const bogus of ["merge_pull_request", "approve_tool_action", "execute_tool_action", ""]) {
      assert.throws(() => new McpCapabilityGuard(["list_tasks", bogus]), McpCapabilityGuardError);
    }
  });

  it("a full grant still denies anything outside the declared surface", () => {
    const guard = new McpCapabilityGuard(Object.keys(MCP_TOOL_OPERATIONS));
    assert.equal(guard.allows("deploy_production"), false);
    assert.deepEqual(guard.decide("deploy_production"), { allowed: false, reason: "unknown-tool" });
    // Every real tool is allowed under a full grant.
    for (const tool of Object.keys(MCP_TOOL_OPERATIONS)) {
      assert.equal(guard.allows(tool), true, tool);
    }
  });

  it("reports its granted tools sorted, without exposing internal state", () => {
    const guard = new McpCapabilityGuard(["list_tasks", "create_task", "get_task"]);
    const granted = guard.grantedTools();
    assert.deepEqual(granted, ["create_task", "get_task", "list_tasks"]);
    // Mutating the returned array does not change the guard.
    granted.push("delete_task");
    assert.equal(guard.allows("delete_task"), false);
  });
});
