import assert from "node:assert/strict";
import { describe, it } from "node:test";

import type { ConvexClientLike } from "../src/persistence/convexPersistence.js";
import type {
  DomainResult,
  OrchestrationContext,
  OrchestrationOutcome,
} from "../src/orchestration/contracts.js";
import { OrchestrationGraph } from "../src/orchestration/graph.js";
import { ConvexOrchestrationStateBoundary } from "../src/orchestration/convexStateBoundary.js";
import {
  createConvexOrchestrationRunner,
  ConvexOrchestrationRunner,
} from "../src/orchestration/convexRunner.js";
import type { OrchestrationSafetyGate, SafetyDecision } from "../src/orchestration/runner.js";

const context: OrchestrationContext = {
  runId: "run-1",
  authority: "T1",
  trigger: {
    id: "trigger-1",
    kind: "test",
    source: "cli",
    idempotencyKey: "idem-1",
    occurredAt: 1,
    payload: { request: "create task" },
  },
};
const graph = new OrchestrationGraph([
  {
    id: "create",
    command: { operationId: "createTask", input: { title: "Inspect mounts" } },
  },
]);
const success: DomainResult = {
  ok: true,
  value: {
    id: "task-1",
    title: "Inspect mounts",
    completed: false,
    category: "personal",
    createdAt: 1,
  },
};
const okDecision: SafetyDecision = { status: "ok", reasons: [] };

function gate(): OrchestrationSafetyGate {
  return {
    preflight: async () => okDecision,
    postflight: async () => okDecision,
  };
}

function fakeClient(
  handler: (args: Record<string, unknown>, functionRef: unknown) => unknown,
): ConvexClientLike {
  return {
    query: async () => null,
    mutation: async (functionRef, args) => handler(args as Record<string, unknown>, functionRef),
  } as ConvexClientLike;
}

describe("ConvexOrchestrationStateBoundary", () => {
  it("maps run metadata and lease-bound step transitions without client timestamps", async () => {
    const calls: Array<{ args: Record<string, unknown> }> = [];
    const client = fakeClient((args, functionRef) => {
      const callIndex = calls.length;
      void functionRef;
      calls.push({ args });
      if (callIndex === 0) {
        return { status: "created", run: { runId: "run-1" } };
      }
      if (callIndex === 1) {
        return { step: {}, leaseToken: "server-lease" };
      }
      return {};
    });
    const state = new ConvexOrchestrationStateBoundary({
      client,
      serviceToken: "service-token",
      workerId: "worker-1",
      leaseTtlMs: 10_000,
    });

    await state.beginRun({
      context,
      graph,
      requestFingerprint: "request-fp",
      planFingerprint: "plan-fp",
      policyVersion: "policy-v1",
      policyFingerprint: "policy-fp",
      maxRetries: 2,
    });
    const lease = await state.start({ context, node: graph.orderedNodes()[0] });
    await state.succeed({
      context,
      node: graph.orderedNodes()[0],
      leaseToken: lease.leaseToken,
      result: success as Extract<DomainResult, { ok: true }>,
    });

    assert.deepEqual(calls[0]?.args, {
      serviceToken: "service-token",
      runId: "run-1",
      triggerId: "trigger-1",
      triggerSource: "cli",
      triggerKind: "test",
      idempotencyKey: "idem-1",
      requestFingerprint: "request-fp",
      planFingerprint: "plan-fp",
      triggerPayload: { request: "create task" },
      authority: "T1",
      policyVersion: "policy-v1",
      policyFingerprint: "policy-fp",
      nodeIds: ["create"],
      maxRetries: 2,
    });
    assert.deepEqual(calls[1]?.args, {
      serviceToken: "service-token",
      runId: "run-1",
      nodeId: "create",
      operationId: "createTask",
      workerId: "worker-1",
      leaseTtlMs: 10_000,
    });
    assert.deepEqual(calls[2]?.args, {
      serviceToken: "service-token",
      runId: "run-1",
      nodeId: "create",
      workerId: "worker-1",
      leaseToken: "server-lease",
    });
    assert.equal("now" in (calls[0]?.args ?? {}), false);
  });
});

describe("ConvexOrchestrationRunner", () => {
  it("does not execute a replayed run", async () => {
    let executions = 0;
    const boundary = new ConvexOrchestrationStateBoundary({
      client: fakeClient(() => ({
        status: "replayed",
        run: { runId: "run-1", state: "succeeded" },
      })),
      serviceToken: "service-token",
      workerId: "worker-1",
      leaseTtlMs: 10_000,
    });
    const runner = createConvexOrchestrationRunner(
      boundary,
      {
        execute: async () => {
          executions += 1;
          return success;
        },
      },
      gate(),
      { record: async (_outcome: OrchestrationOutcome) => undefined },
    );
    const coordinator = new ConvexOrchestrationRunner(boundary, runner);

    const result = await coordinator.run(graph, context, {
      requestFingerprint: "request-fp",
      planFingerprint: "plan-fp",
      policyVersion: "policy-v1",
      policyFingerprint: "policy-fp",
      maxRetries: 2,
    });

    assert.deepEqual(result, {
      status: "replayed",
      run: { runId: "run-1", state: "succeeded" },
    });
    assert.equal(executions, 0);
  });

  it("acquires a lease before execution and commits durable success after the audit record", async () => {
    const events: string[] = [];
    const boundary = new ConvexOrchestrationStateBoundary({
      client: fakeClient((_args, _functionRef) => {
        if (events.length === 0) {
          events.push("begin");
          return { status: "created", run: { runId: "run-1" } };
        }
        if (events.length === 1) {
          events.push("start");
          return { step: {}, leaseToken: "server-lease" };
        }
        events.push("succeed");
        return {};
      }),
      serviceToken: "service-token",
      workerId: "worker-1",
      leaseTtlMs: 10_000,
    });
    const runner = createConvexOrchestrationRunner(
      boundary,
      {
        execute: async () => {
          events.push("execute");
          return success;
        },
      },
      gate(),
      {
        record: async () => {
          events.push("audit");
        },
      },
    );
    const coordinator = new ConvexOrchestrationRunner(boundary, runner);

    const result = await coordinator.run(graph, context, {
      requestFingerprint: "request-fp",
      planFingerprint: "plan-fp",
      policyVersion: "policy-v1",
      policyFingerprint: "policy-fp",
      maxRetries: 2,
    });

    assert.equal(result.status, "created");
    assert.deepEqual(events, ["begin", "start", "execute", "audit", "succeed"]);
  });
});
