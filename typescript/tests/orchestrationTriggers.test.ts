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
  it("dispatches a validated real trigger to its registered graph builder", async () => {
    const registry = new OrchestrationTriggerRegistry();
    let validated: OrchestrationTrigger | undefined;
    registry.register("operator.request", (received) => {
      validated = received;
      assert.equal(received.id, "trigger-1");
      assert.equal(received.source, "http");
      return new OrchestrationGraph();
    });

    const graph = await registry.dispatch(trigger);

    assert.equal(graph.orderedNodes().length, 0);
    assert.ok(validated);
    assert.notEqual(validated.payload, trigger.payload);
    assert.equal(Object.isFrozen(validated), true);
    assert.equal(Object.isFrozen(validated.payload), true);
  });

  it("rejects duplicate handlers and unknown trigger kinds", async () => {
    const registry = new OrchestrationTriggerRegistry();
    registry.register("operator.request", () => new OrchestrationGraph());

    assert.throws(
      () => registry.register("operator.request", () => new OrchestrationGraph()),
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
  });

  it("validates required trigger fields and source", async () => {
    const registry = new OrchestrationTriggerRegistry();
    registry.register("operator.request", () => new OrchestrationGraph());

    await assert.rejects(
      () => registry.dispatch({ ...trigger, idempotencyKey: " " }),
      /idempotencyKey is required/,
    );
    await assert.rejects(
      () =>
        registry.dispatch({
          ...trigger,
          source: "remote" as OrchestrationTrigger["source"],
        }),
      /source is invalid/,
    );

    const callerPayload = { intent: "create-task" };
    const received = { ...trigger, payload: callerPayload };
    await registry.dispatch(received);
    callerPayload.intent = "changed";
    assert.equal(received.payload.intent, "changed");
  });
});
