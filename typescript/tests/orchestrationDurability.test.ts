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
import { ConvexOrchestrationRunner } from "../src/orchestration/convexRunner.js";
import {
  OrchestrationRunner,
  type OrchestrationSafetyGate,
  type SafetyDecision,
} from "../src/orchestration/runner.js";
import type { OrchestrationStepStateBoundary } from "../src/orchestration/stateBoundary.js";
import { orchestrationPlanFingerprint } from "../src/orchestration/fingerprints.js";

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
    const coordinator = new ConvexOrchestrationRunner(
      boundary,
      {
        execute: async () => {
          executions += 1;
          return success;
        },
      },
      gate(),
      { record: async (_outcome: OrchestrationOutcome) => undefined },
      { policyVersion: "policy-v1", policyFingerprint: "policy-fp" },
    );

    const result = await coordinator.run(graph, context, {
      requestFingerprint: "request-fp",
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
    let beginArgs: Record<string, unknown> | undefined;
    const boundary = new ConvexOrchestrationStateBoundary({
      client: fakeClient((args, _functionRef) => {
        if (events.length === 0) {
          beginArgs = args;
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
    const coordinator = new ConvexOrchestrationRunner(
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
      { policyVersion: "policy-v1", policyFingerprint: "policy-fp" },
    );

    const result = await coordinator.run(graph, context, {
      requestFingerprint: "request-fp",
      maxRetries: 2,
    });

    assert.equal(result.status, "created");
    assert.equal(beginArgs?.planFingerprint, orchestrationPlanFingerprint(graph));
    assert.equal(beginArgs?.policyVersion, "policy-v1");
    assert.equal(beginArgs?.policyFingerprint, "policy-fp");
    assert.deepEqual(events, ["begin", "start", "execute", "audit", "succeed"]);
  });
});

describe("OrchestrationRunner durable failure boundary", () => {
  it("does not create a durable lease when the execution budget is exhausted before start", async () => {
    const events: string[] = [];
    const stepState: OrchestrationStepStateBoundary = {
      start: async () => {
        events.push("start");
        return { leaseToken: "unexpected-lease" };
      },
      succeed: async () => {
        events.push("succeed");
      },
      fail: async () => {
        events.push("fail");
      },
    };
    let now = 100;
    const runner = new OrchestrationRunner(
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
      {
        stepState,
        maxDurationMs: 1,
        clock: () => now++,
      },
    );

    const result = await runner.run(graph, context);

    assert.equal(result.ok, false);
    assert.deepEqual(events, ["audit"]);
  });

  it("records a leased preflight failure before marking the durable step failed", async () => {
    const events: string[] = [];
    const stepState: OrchestrationStepStateBoundary = {
      start: async () => {
        events.push("start");
        return { leaseToken: "lease-1" };
      },
      succeed: async () => {
        events.push("succeed");
      },
      fail: async ({ leaseToken }) => {
        events.push(`fail:${leaseToken}`);
      },
    };
    const blockedGate: OrchestrationSafetyGate = {
      preflight: async () => ({ status: "blocked", reasons: ["policy denied"] }),
      postflight: async () => okDecision,
    };
    const runner = new OrchestrationRunner(
      {
        execute: async () => {
          events.push("execute");
          return success;
        },
      },
      blockedGate,
      {
        record: async () => {
          events.push("audit");
        },
      },
      { stepState },
    );

    const result = await runner.run(graph, context);

    assert.equal(result.ok, false);
    assert.deepEqual(events, ["start", "audit", "fail:lease-1"]);
  });

  it("records an executor failure before marking the durable step failed", async () => {
    const events: string[] = [];
    const stepState: OrchestrationStepStateBoundary = {
      start: async () => {
        events.push("start");
        return { leaseToken: "lease-1" };
      },
      succeed: async () => {
        events.push("succeed");
      },
      fail: async ({ leaseToken }) => {
        events.push(`fail:${leaseToken}`);
      },
    };
    const runner = new OrchestrationRunner(
      {
        execute: async () => {
          events.push("execute");
          return {
            ok: false,
            code: "dependency_failure",
            message: "provider unavailable",
            retryable: true,
          };
        },
      },
      gate(),
      {
        record: async () => {
          events.push("audit");
        },
      },
      { stepState },
    );

    const result = await runner.run(graph, context);

    assert.equal(result.ok, false);
    assert.deepEqual(events, ["start", "execute", "audit", "fail:lease-1"]);
  });
});

describe("orchestration composition authority", () => {
  it("changes the plan fingerprint when graph execution semantics change", () => {
    const changedGraph = new OrchestrationGraph([
      {
        id: "create",
        command: { operationId: "createTask", input: { title: "Inspect another mount" } },
      },
    ]);

    assert.notEqual(
      orchestrationPlanFingerprint(changedGraph),
      orchestrationPlanFingerprint(graph),
    );

    it("ignores dependency declaration order when execution semantics are unchanged", () => {
      const first = new OrchestrationGraph([
        {
          id: "a",
          command: { operationId: "createTask", input: { title: "A" } },
        },
        {
          id: "b",
          command: { operationId: "createTask", input: { title: "B" } },
        },
        {
          id: "join",
          command: { operationId: "createTask", input: { title: "Join" } },
          dependsOn: ["a", "b"],
        },
      ]);
      const reordered = new OrchestrationGraph([
        {
          id: "a",
          command: { operationId: "createTask", input: { title: "A" } },
        },
        {
          id: "b",
          command: { operationId: "createTask", input: { title: "B" } },
        },
        {
          id: "join",
          command: { operationId: "createTask", input: { title: "Join" } },
          dependsOn: ["b", "a"],
        },
      ]);

      assert.equal(orchestrationPlanFingerprint(first), orchestrationPlanFingerprint(reordered));
    });
  });
});
