import assert from "node:assert/strict";
import { describe, it } from "node:test";

import type {
  DomainResult,
  OrchestrationCommand,
  OrchestrationContext,
  OrchestrationOutcome,
} from "../src/orchestration/contracts.js";
import { OrchestrationGraph } from "../src/orchestration/graph.js";
import {
  OrchestrationRunner,
  type OrchestrationSafetyGate,
  type SafetyDecision,
} from "../src/orchestration/runner.js";

const context: OrchestrationContext = { runId: "run-1", authority: "T1" };
const command: OrchestrationCommand = {
  operationId: "createTask",
  input: { title: "Inspect mounts", category: "build" },
};
const success: DomainResult = {
  ok: true,
  value: {
    id: "task-1",
    title: "Inspect mounts",
    completed: false,
    category: "build",
    createdAt: 1,
  },
};
const okDecision: SafetyDecision = { status: "ok", reasons: [] };

function gate(overrides: Partial<OrchestrationSafetyGate> = {}): OrchestrationSafetyGate {
  return {
    preflight: async () => okDecision,
    postflight: async () => okDecision,
    ...overrides,
  };
}

function recorder(outcomes: OrchestrationOutcome[]) {
  return {
    record: async (outcome: OrchestrationOutcome) => void outcomes.push(outcome),
  };
}

describe("OrchestrationRunner", () => {
  it("blocks before execution when preflight safety fails", async () => {
    let executions = 0;
    const outcomes: OrchestrationOutcome[] = [];
    const runner = new OrchestrationRunner(
      {
        execute: async () => {
          executions += 1;
          return success;
        },
      },
      gate({
        preflight: async () => ({
          status: "blocked",
          reasons: ["approval required"],
        }),
      }),
      recorder(outcomes),
    );

    const result = await runner.run(new OrchestrationGraph([{ id: "create", command }]), context);

    assert.equal(result.ok, false);
    if (result.ok) return;
    assert.equal(result.failure.code, "blocked");
    assert.equal(executions, 0);
    assert.deepEqual(outcomes, [
      {
        runId: "run-1",
        nodeId: "create",
        operationId: "createTask",
        success: false,
        failureCode: "blocked",
      },
    ]);
  });

  it("stops on an explicit domain failure and records it as failed", async () => {
    const executed: string[] = [];
    const outcomes: OrchestrationOutcome[] = [];
    const graph = new OrchestrationGraph([
      { id: "first", command },
      {
        id: "second",
        command: { operationId: "completeTask", input: { taskId: "missing" } },
        dependsOn: ["first"],
      },
    ]);
    const runner = new OrchestrationRunner(
      {
        execute: async (current) => {
          executed.push(current.operationId);
          if (current.operationId === "createTask") {
            return {
              ok: false,
              code: "conflict",
              message: "Task already exists.",
              retryable: false,
            };
          }
          return success;
        },
      },
      gate(),
      recorder(outcomes),
    );

    const result = await runner.run(graph, context);

    assert.equal(result.ok, false);
    if (result.ok) return;
    assert.equal(result.failure.code, "conflict");
    assert.deepEqual(executed, ["createTask"]);
    assert.equal(outcomes[0]?.success, false);
  });

  it("fails closed when postflight consistency is not satisfied", async () => {
    const outcomes: OrchestrationOutcome[] = [];
    const runner = new OrchestrationRunner(
      { execute: async () => success },
      gate({
        postflight: async () => ({
          status: "blocked",
          reasons: ["persisted task state did not match the returned task"],
        }),
      }),
      recorder(outcomes),
    );

    const result = await runner.run(new OrchestrationGraph([{ id: "create", command }]), context);

    assert.equal(result.ok, false);
    if (result.ok) return;
    assert.equal(result.failure.code, "postcondition_failed");
    assert.equal(result.completedSteps.length, 0);
    assert.equal(result.executedResult?.ok, true);
    assert.equal(outcomes[0]?.success, false);
  });

  it("records completed steps only after postflight verification", async () => {
    const outcomes: OrchestrationOutcome[] = [];
    const runner = new OrchestrationRunner(
      { execute: async () => success },
      gate(),
      recorder(outcomes),
    );

    const result = await runner.run(new OrchestrationGraph([{ id: "create", command }]), context);

    assert.equal(result.ok, true);
    if (!result.ok) return;
    assert.equal(result.completedSteps.length, 1);
    assert.equal(result.completedSteps[0]?.operationId, "createTask");
    assert.deepEqual(outcomes, [
      {
        runId: "run-1",
        nodeId: "create",
        operationId: "createTask",
        success: true,
      },
    ]);
  });

  it("surfaces an executed result when success auditing fails", async () => {
    const runner = new OrchestrationRunner({ execute: async () => success }, gate(), {
      record: async () => {
        throw new Error("journal unavailable");
      },
    });

    const result = await runner.run(new OrchestrationGraph([{ id: "create", command }]), context);

    assert.equal(result.ok, false);
    if (result.ok) return;
    assert.equal(result.failure.code, "audit_failure");
    assert.equal(result.executedResult?.ok, true);
  });

  it("turns thrown executor errors into failed outcomes", async () => {
    const outcomes: OrchestrationOutcome[] = [];
    const runner = new OrchestrationRunner(
      {
        execute: async () => {
          throw new Error("provider unavailable");
        },
      },
      gate(),
      recorder(outcomes),
    );

    const result = await runner.run(new OrchestrationGraph([{ id: "create", command }]), context);

    assert.equal(result.ok, false);
    if (result.ok) return;
    assert.equal(result.failure.code, "dependency_failure");
    assert.equal(result.failure.retryable, true);
    assert.equal(outcomes[0]?.failureCode, "dependency_failure");
  });
it("enforces a maximum step budget before a later command crosses the effect boundary", async () => {
  const executed: string[] = [];
  const outcomes: OrchestrationOutcome[] = [];
  const runner = new OrchestrationRunner(
    {
      execute: async (current) => {
        executed.push(current.operationId);
        return success;
      },
    },
    gate(),
    recorder(outcomes),
    { maxSteps: 1 },
  );
  const graph = new OrchestrationGraph([
    { id: "first", command },
    {
      id: "second",
      command: { operationId: "completeTask", input: { taskId: "task-1" } },
      dependsOn: ["first"],
    },
  ]);

  const result = await runner.run(graph, context);

  assert.equal(result.ok, false);
  if (result.ok) return;
  assert.equal(result.failure.code, "execution_budget_exceeded");
  assert.equal(result.failure.retryable, true);
  assert.deepEqual(executed, ["createTask"]);
  assert.equal(result.completedSteps.length, 1);
  assert.equal(outcomes.at(-1)?.failureCode, "execution_budget_exceeded");
});

it("halts when the run deadline is exhausted and preserves completed-step recovery evidence", async () => {
  let now = 100;
  const executed: string[] = [];
  const runner = new OrchestrationRunner(
    {
      execute: async (current) => {
        executed.push(current.operationId);
        now = 250;
        return success;
      },
    },
    gate(),
    recorder([]),
    { maxDurationMs: 100, clock: () => now },
  );
  const graph = new OrchestrationGraph([
    { id: "first", command },
    {
      id: "second",
      command: { operationId: "completeTask", input: { taskId: "task-1" } },
      dependsOn: ["first"],
    },
  ]);

  const result = await runner.run(graph, context);

  assert.equal(result.ok, false);
  if (result.ok) return;
  assert.equal(result.failure.code, "execution_budget_exceeded");
  assert.equal(result.failure.retryable, true);
  assert.deepEqual(executed, ["createTask"]);
  assert.equal(result.completedSteps.length, 1);
});

it("rejects non-positive execution budgets at construction", () => {
  assert.throws(
    () => new OrchestrationRunner({ execute: async () => success }, gate(), recorder([]), { maxSteps: 0 }),
    /maxSteps must be a positive safe integer/,
  );
  assert.throws(
    () => new OrchestrationRunner({ execute: async () => success }, gate(), recorder([]), { maxDurationMs: 0 }),
    /maxDurationMs must be a positive safe integer/,
  );
});

});
