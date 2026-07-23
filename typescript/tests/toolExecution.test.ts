import assert from "node:assert/strict";
import { describe, it } from "node:test";

import { z } from "zod";

import type { ToolAction } from "../src/actions/toolActions.js";
import {
  InMemoryToolExecutionReceiptStore,
  ToolExecutionService,
} from "../src/actions/toolExecution.js";

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
    const unauthorized = await executor.execute({
      action,
      authority: "T0",
      idempotencyKey: "one",
    });
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
    const real = await executor.execute({
      action,
      authority: "T1",
      idempotencyKey: "same",
    });
    assert.equal(real.status, "succeeded");
    assert.equal(executions, 1);
    const first = await executor.execute({
      action,
      authority: "T1",
      idempotencyKey: "execute",
    });
    const replay = await executor.execute({
      action,
      authority: "T1",
      idempotencyKey: "execute",
    });
    assert.equal(first.status, "succeeded");
    assert.deepEqual(replay, first);
    assert.equal(executions, 2);
  });

  it("deduplicates concurrent execution in one runtime", async () => {
    let executions = 0;
    const executor = new ToolExecutionService([
      {
        tool: "clock",
        operation: "read",
        schema: z.object({ zone: z.string() }),
        async execute() {
          executions += 1;
          await new Promise((resolve) => setTimeout(resolve, 10));
          return { now: "2026-07-18T00:00:00.000Z" };
        },
      },
    ]);
    const [first, second] = await Promise.all([
      executor.execute({
        action,
        authority: "T1",
        idempotencyKey: "concurrent",
      }),
      executor.execute({
        action,
        authority: "T1",
        idempotencyKey: "concurrent",
      }),
    ]);
    assert.equal(executions, 1);
    assert.deepEqual(second, first);
  });

  it("blocks a concurrent call carrying different action content instead of returning the in-flight result", async () => {
    // Red-team finding: the in-flight de-duplication map used to hand back
    // whatever was already executing under the same actionId:idempotencyKey
    // pair without checking whether the *new* caller's action content
    // actually matched it. A second, differently-shaped concurrent call
    // would silently receive the first caller's receipt — and its own
    // arguments would never be validated or executed at all.
    const executed: Array<Record<string, unknown>> = [];
    const executor = new ToolExecutionService([
      {
        tool: "clock",
        operation: "read",
        schema: z.object({ zone: z.string() }),
        async execute(args) {
          executed.push(args);
          await new Promise((resolve) => setTimeout(resolve, 10));
          return { now: "2026-07-18T00:00:00.000Z" };
        },
      },
    ]);
    const differentAction = { ...action, arguments: { zone: "Australia/Melbourne" } };

    const [first, second] = await Promise.all([
      executor.execute({ action, authority: "T1", idempotencyKey: "racing" }),
      executor.execute({
        action: differentAction,
        authority: "T1",
        idempotencyKey: "racing",
      }),
    ]);

    assert.equal(first.status, "succeeded");
    assert.equal(second.status, "blocked");
    assert.equal(second.errorCode, "fingerprint-mismatch");
    assert.notDeepEqual(second, first);
    // The second caller's own arguments must never reach the executor.
    assert.equal(executed.length, 1);
    assert.deepEqual(executed[0], { zone: "UTC" });
  });

  it("blocks replay when the approved action payload changes", async () => {
    const receipts = new InMemoryToolExecutionReceiptStore();
    const executor = new ToolExecutionService(
      [
        {
          tool: "clock",
          operation: "read",
          schema: z.object({ zone: z.string() }),
          async execute() {
            return { now: "2026-07-18T00:00:00.000Z" };
          },
        },
      ],
      receipts,
    );
    const first = await executor.execute({
      action,
      authority: "T1",
      idempotencyKey: "bound",
    });
    assert.equal(first.status, "succeeded");
    const changed = await executor.execute({
      action: { ...action, arguments: { zone: "Australia/Melbourne" } },
      authority: "T1",
      idempotencyKey: "bound",
    });
    assert.equal(changed.status, "blocked");
    assert.equal(changed.errorCode, "fingerprint-mismatch");
  });

  it("records timeouts as indeterminate without exposing tool output", async () => {
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
    assert.equal(result.status, "indeterminate");
    assert.equal(result.errorCode, "indeterminate");
    assert.equal(result.outputDigest, undefined);
    assert.equal(JSON.stringify(result).includes("never stored"), false);

    const replay = await executor.execute({
      action: { ...action, tool: "slow", arguments: {} },
      authority: "T1",
      idempotencyKey: "timeout",
    });
    assert.deepEqual(replay, result);
  });
});
