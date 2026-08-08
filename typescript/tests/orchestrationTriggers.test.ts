import assert from "node:assert/strict";
import { describe, it } from "node:test";

import { OrchestrationGraph } from "../src/orchestration/graph.js";
import {
  OrchestrationTriggerRegistry,
  type OrchestrationTrigger,
} from "../src/orchestration/trigger.js";

const trigger: OrchestrationTrigger = {
  id: "trigger-1",
  kind: "operator.request",
  source: "http",
  idempotencyKey: "request-1",
  occurredAt: 1_000,
  payload: { intent: "create-task" },
};

describe("OrchestrationTriggerRegistry", () => {
  it("dispatches a validated real trigger to its registered graph builder", () => {
    const registry = new OrchestrationTriggerRegistry();
    registry.register("operator.request", (received) => {
      assert.equal(received.id, "trigger-1");
      assert.equal(received.source, "http");
      return new OrchestrationGraph();
    });

    return registry.dispatch(trigger).then((graph) => {
      assert.equal(graph.orderedNodes().length, 0);
    });
  });

  it("rejects duplicate handlers, unknown trigger kinds, and mutable trigger payloads", async () => {
    const registry = new OrchestrationTriggerRegistry();
    registry.register("operator.request", () => new OrchestrationGraph());

    assert.throws(
      () =>
        registry.register("operator.request", () => new OrchestrationGraph()),
      /already registered/,
    );
    await assert.rejects(
      () =>
        registry.dispatch({
          ...trigger,
          kind: "scheduler.tick",
        }),
      /Unknown orchestration trigger kind/,
    );

    const received = {
      ...trigger,
      payload: { intent: "create-task", metadata: { operator: "benny" } },
    };
    const frozenRegistry = new OrchestrationTriggerRegistry();
    frozenRegistry.register("operator.request", (value) => {
      assert.equal(Object.isFrozen(value), true);
      assert.equal(Object.isFrozen(value.payload), true);
      assert.equal(Object.isFrozen(value.payload.metadata), true);
      assert.notEqual(value.payload, received.payload);
      return new OrchestrationGraph();
    });
    await frozenRegistry.dispatch(received);
    received.payload.intent = "mutated";
    received.payload.metadata.operator = "mutated";
    assert.equal(received.payload.intent, "mutated");
    assert.equal(received.payload.metadata.operator, "mutated");
  });
});
