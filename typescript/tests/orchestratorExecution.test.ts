import assert from "node:assert/strict";
import { describe, it } from "node:test";

import { ConversationService } from "../src/agent/conversationService.js";
import { Orchestrator, type ExecutionPolicy } from "../src/agent/orchestrator.js";

function makeOrchestrator(policy: ExecutionPolicy) {
  const calls: string[] = [];
  const router = {
    async route(module: string, action: string): Promise<unknown> {
      calls.push(`${module}:${action}`);
      if (action === "fail") throw new Error("provider detail must not escape");
      return { module, action, status: "completed" };
    },
  };
  const memory = { write: () => undefined };
  const safety = {
    evaluate: () => ({ status: "ok" as const, reasons: [] }),
  };
  const zState = {
    canActivate: () => ({ active: false, reasons: ["bounded execution"] }),
  };
  const graph = {
    getNodesForIntent: () => [
      { module: "business", action: "low", weight: 0.2 },
      { module: "business", action: "high", weight: 1 },
      { module: "business", action: "middle", weight: 0.6 },
    ],
  };

  const orchestrator = new Orchestrator(
    memory as never,
    router as never,
    safety as never,
    graph as never,
    zState as never,
    () => [],
    { execution: policy },
  );

  return { orchestrator, calls };
}

describe("bounded production orchestration", () => {
  it("uses workflow weights and enforces the configured step budget", () => {
    const { orchestrator, calls } = makeOrchestrator({ maxSteps: 2, maxFailures: 0 });
    const plan = orchestrator.plan(new ConversationService().parse("start job j1"));

    assert.deepEqual(
      plan.steps.map((step) => step.action),
      ["high", "middle"],
    );

    return orchestrator.execute(plan).then((result) => {
      assert.deepEqual(calls, ["business:high", "business:middle"]);
      assert.equal(result.recovery.status, "halted");
      assert.equal(result.recovery.reason, "step-budget-exhausted");
      assert.equal(result.recovery.attemptedSteps, 2);
    });
  });

  it("halts on the first failed step and redacts the thrown error", async () => {
    const { orchestrator, calls } = makeOrchestrator({ maxSteps: 5, maxFailures: 0 });
    const plan = {
      trigger: { source: "conversation" as const, raw: "start job j1", intent: "start_job" },
      steps: [
        { module: "business", action: "fail", weight: 1, payload: {} },
        { module: "business", action: "after-failure", weight: 0.5, payload: {} },
      ],
    };

    const result = await orchestrator.execute(plan);
    assert.deepEqual(calls, ["business:fail"]);
    assert.equal(result.recovery.status, "halted");
    assert.equal(result.recovery.reason, "failure-budget-exhausted");
    assert.deepEqual(result.outputs, [{ errorCode: "execution-failed", module: "business", action: "fail" }]);
    assert.equal(JSON.stringify(result), JSON.stringify(result).replace("provider detail must not escape", ""));
  });
});
