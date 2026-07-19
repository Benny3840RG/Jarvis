import assert from "node:assert/strict";
import { describe, it } from "node:test";

import { z } from "zod";

import type { ToolAction } from "../src/actions/toolActions.js";
import { ToolExecutionService } from "../src/actions/toolExecution.js";

const action: ToolAction = {
  actionId: "action-1",
  requestId: "request-1",
  projectId: "project-1",
  baseRevision: 1,
  state: "approved",
  tool: "clock",
  operation: "read",
  arguments: { zone: "UTC" },
  rationale: "Read the current time.",
  requiredAuthority: "T1",
  destructive: false,
  idempotencyKey: "proposal-1",
  proposedBy: "user",
  approvedBy: "user",
  createdAt: new Date().toISOString(),
  updatedAt: new Date().toISOString(),
};

describe("tool execution stage", () => {
  it("blocks unauthorized and non-allowlisted actions", async () => {
    let executions = 0;
    const executor = new ToolExecutionService([
      {
        tool: "clock",
        operation: "read",
        schema: z.object({ zone: z.string() }),
        async execute() {
          executions += 1;
          return { now: "2026-07-18T00:00:00.000Z" };
        },
      },
    ]);
    const unauthorized = await executor.execute({ action, authority: "T0", idempotencyKey: "one" });
    assert.equal(unauthorized.errorCode, "not-authorized");
    const unknown = await executor.execute({
      action: { ...action, operation: "write" },
      authority: "T1",
      idempotencyKey: "two",
    });
    assert.equal(unknown.errorCode, "not-allowlisted");
    assert.equal(executions, 0);
  });

  it("supports dry-run and replay-safe receipts", async () => {
    let executions = 0;
    const executor = new ToolExecutionService([
      {
        tool: "clock",
        operation: "read",
        schema: z.object({ zone: z.string() }),
        async execute() {
          executions += 1;
          return { now: "2026-07-18T00:00:00.000Z" };
        },
      },
    ]);
    const dryRun = await executor.execute({
      action,
      authority: "T1",
      idempotencyKey: "same",
      dryRun: true,
    });
    assert.equal(dryRun.status, "dry-run");
    assert.equal(executions, 0);
    // dry-run must not persist — the same key must allow a real execution
    const real = await executor.execute({ action, authority: "T1", idempotencyKey: "same" });
    assert.equal(real.status, "succeeded");
    assert.equal(executions, 1);
    const first = await executor.execute({ action, authority: "T1", idempotencyKey: "execute" });
    const replay = await executor.execute({ action, authority: "T1", idempotencyKey: "execute" });
    assert.equal(first.status, "succeeded");
    assert.deepEqual(replay, first);
    assert.equal(executions, 2);
  });

  it("records timeouts without exposing tool output", async () => {
    const executor = new ToolExecutionService([
      {
        tool: "slow",
        operation: "read",
        schema: z.object({}),
        async execute() {
          await new Promise((resolve) => setTimeout(resolve, 20));
          return { secret: "never stored" };
        },
      },
    ]);
    const result = await executor.execute({
      action: { ...action, tool: "slow", arguments: {} },
      authority: "T1",
      idempotencyKey: "timeout",
      timeoutMs: 1,
    });
    assert.equal(result.status, "timed-out");
    assert.equal(result.outputDigest, undefined);
    assert.equal(JSON.stringify(result).includes("never stored"), false);
  });
});
