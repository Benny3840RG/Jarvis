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

describe("consent-lifecycle execution enforcement (R-048/R-049/R-050)", () => {
  function definition(executions: { count: number }) {
    return {
      tool: "clock",
      operation: "read",
      schema: z.object({ zone: z.string() }),
      async execute() {
        executions.count += 1;
        return { now: "2026-07-18T00:00:00.000Z" };
      },
    };
  }

  it("blocks execution when the fetched action's approval has already expired", async () => {
    const executions = { count: 0 };
    const executor = new ToolExecutionService([definition(executions)]);

    const result = await executor.execute({
      action: { ...action, isApprovalExpired: true },
      authority: "T1",
      idempotencyKey: "expired-attempt",
    });

    assert.equal(result.status, "blocked");
    assert.equal(result.errorCode, "approval-expired");
    assert.equal(executions.count, 0);
  });

  it("still blocks a revoked action as not-authorized, never reaching the definition", async () => {
    const executions = { count: 0 };
    const executor = new ToolExecutionService([definition(executions)]);

    const result = await executor.execute({
      action: { ...action, state: "revoked", revokedBy: "user", revokedReason: "no longer needed" },
      authority: "T1",
      idempotencyKey: "revoked-attempt",
    });

    assert.equal(result.status, "blocked");
    assert.equal(result.errorCode, "not-authorized");
    assert.equal(executions.count, 0);
  });

  it("blocks a live re-execution of an already-consumed single-use action under a different key", async () => {
    const executions = { count: 0 };
    const receipts = new InMemoryToolExecutionReceiptStore();
    const executor = new ToolExecutionService([definition(executions)], receipts);
    const singleUse = { ...action, consumptionPolicy: "single-use" as const };

    const first = await executor.execute({
      action: singleUse,
      authority: "T1",
      idempotencyKey: "first-key",
    });
    assert.equal(first.status, "succeeded");
    assert.equal(executions.count, 1);

    const second = await executor.execute({
      action: singleUse,
      authority: "T1",
      idempotencyKey: "second-key",
    });

    assert.equal(second.status, "blocked");
    assert.equal(second.errorCode, "approval-consumed");
    assert.equal(executions.count, 1, "the already-consumed action must not be executed again");
  });

  it("blocks a genuinely concurrent execution of a single-use action under different keys — the definition is invoked at most once", async () => {
    // Regression for a real race: two different-key attempts must not both
    // observe "not yet consumed" and both cross the external-effect
    // boundary. Both calls are dispatched together via Promise.all so their
    // internal awaits (receipt lookup, in-flight check, schema parse) truly
    // interleave, the same way two concurrent HTTP requests would.
    const invocations: string[] = [];
    const receipts = new InMemoryToolExecutionReceiptStore();
    const executor = new ToolExecutionService(
      [
        {
          tool: "clock",
          operation: "read",
          schema: z.object({ zone: z.string() }),
          async execute() {
            invocations.push("call");
            await new Promise((resolve) => setTimeout(resolve, 15));
            return { now: "2026-07-18T00:00:00.000Z" };
          },
        },
      ],
      receipts,
    );
    const singleUse = { ...action, consumptionPolicy: "single-use" as const };

    const [first, second] = await Promise.all([
      executor.execute({ action: singleUse, authority: "T1", idempotencyKey: "concurrent-a" }),
      executor.execute({ action: singleUse, authority: "T1", idempotencyKey: "concurrent-b" }),
    ]);

    assert.equal(invocations.length, 1, "the definition must be invoked exactly once");
    const outcomes = [first.status, second.status].sort();
    assert.deepEqual(outcomes, ["blocked", "succeeded"]);
    const loser = first.status === "blocked" ? first : second;
    assert.equal(loser.errorCode, "approval-consumed");
  });

  it("does not block a dry-run against an already-consumed single-use action", async () => {
    const executions = { count: 0 };
    const receipts = new InMemoryToolExecutionReceiptStore();
    const executor = new ToolExecutionService([definition(executions)], receipts);
    const singleUse = { ...action, consumptionPolicy: "single-use" as const };

    await executor.execute({
      action: singleUse,
      authority: "T1",
      idempotencyKey: "first-key",
    });
    assert.equal(executions.count, 1);

    const dryRun = await executor.execute({
      action: singleUse,
      authority: "T1",
      idempotencyKey: "dry-run-key",
      dryRun: true,
    });

    assert.equal(dryRun.status, "dry-run");
    assert.equal(dryRun.errorCode, undefined);
    assert.equal(executions.count, 1, "dry-run must never invoke the definition");
  });

  it("allows a second live execution of a reusable (non-single-use) action under a different key", async () => {
    const executions = { count: 0 };
    const receipts = new InMemoryToolExecutionReceiptStore();
    const executor = new ToolExecutionService([definition(executions)], receipts);
    const reusable = { ...action, consumptionPolicy: "reusable" as const };

    const first = await executor.execute({
      action: reusable,
      authority: "T1",
      idempotencyKey: "first-key",
    });
    const second = await executor.execute({
      action: reusable,
      authority: "T1",
      idempotencyKey: "second-key",
    });

    assert.equal(first.status, "succeeded");
    assert.equal(second.status, "succeeded");
    assert.equal(executions.count, 2);
  });
});
