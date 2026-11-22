import assert from "node:assert/strict";
import { describe, it } from "node:test";

import { z } from "zod";

import type { ToolAction } from "../src/actions/toolActions.js";
import {
  InMemoryToolExecutionReceiptStore,
  MAX_TOOL_EXECUTION_TIMEOUT_MS,
  ToolExecutionService,
  type ToolExecutionDefinition,
} from "../src/actions/toolExecution.js";

function action(): ToolAction {
  return {
    actionId: "slow-action",
    requestId: "request-1",
    projectId: "project-1",
    baseRevision: 1,
    state: "approved",
    tool: "slow",
    operation: "effect",
    arguments: { body: "x" },
    rationale: "Exercise the execution limit.",
    requiredAuthority: "T1",
    destructive: false,
    idempotencyKey: "proposal-1",
    proposedBy: "agent",
    approvedBy: "user",
    createdAt: "2026-11-22T00:00:00.000Z",
    updatedAt: "2026-11-22T00:00:00.000Z",
    approvedAt: "2026-11-22T00:00:00.000Z",
  };
}

function slowDefinition(delayMs: number, defaultTimeoutMs?: number): ToolExecutionDefinition {
  return {
    tool: "slow",
    operation: "effect",
    schema: z.object({ body: z.string() }),
    ...(defaultTimeoutMs === undefined ? {} : { defaultTimeoutMs }),
    async execute(_arguments, signal) {
      await new Promise<void>((resolve, reject) => {
        const timer = setTimeout(resolve, delayMs);
        signal.addEventListener(
          "abort",
          () => {
            clearTimeout(timer);
            reject(new Error("aborted"));
          },
          { once: true },
        );
      });
      return { done: true };
    },
  };
}

async function run(definition: ToolExecutionDefinition, timeoutMs?: number) {
  const service = new ToolExecutionService([definition], new InMemoryToolExecutionReceiptStore());
  return service.execute({
    action: action(),
    authority: "T1",
    idempotencyKey: `key-${Math.random()}`,
    ...(timeoutMs === undefined ? {} : { timeoutMs }),
  });
}

describe("tool definition default execution limit", () => {
  it("applies the definition's limit when the request gives none", async (t) => {
    const warn = t.mock.method(console, "warn", () => undefined);
    const receipt = await run(slowDefinition(300, 20));
    assert.equal(receipt.status, "indeterminate");
    assert.equal(warn.mock.callCount(), 1);
    assert.match(String(warn.mock.calls[0]?.arguments[0]), /reached its 20 ms execution limit/u);
  });

  it("lets an effect finish within a longer definition limit", async () => {
    // 60 ms stands in for "longer than the default"; the default itself is not changed.
    const receipt = await run(slowDefinition(60, 1_000));
    assert.equal(receipt.status, "succeeded");
  });

  it("keeps an explicit request timeout ahead of the definition's limit", async (t) => {
    t.mock.method(console, "warn", () => undefined);
    const receipt = await run(slowDefinition(300, 5_000), 20);
    assert.equal(receipt.status, "indeterminate");
  });

  it("refuses a definition limit outside 1..maximum at construction", () => {
    for (const bad of [0, -1, 1.5, MAX_TOOL_EXECUTION_TIMEOUT_MS + 1]) {
      assert.throws(
        () => new ToolExecutionService([slowDefinition(1, bad)]),
        /defaultTimeoutMs must be an integer between 1 and 30000/u,
      );
    }
  });
});
