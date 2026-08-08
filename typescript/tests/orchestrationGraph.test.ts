import assert from "node:assert/strict";
import { describe, it } from "node:test";

import { OrchestrationGraph } from "../src/orchestration/graph.js";

const createTask = {
  operationId: "createTask" as const,
  input: { title: "Inspect mounts" },
};

const completeTask = {
  operationId: "completeTask" as const,
  input: { taskId: "task-1" },
};

describe("OrchestrationGraph", () => {
  it("preserves the legacy node and edge plan surface", () => {
    const graph = new OrchestrationGraph();
    graph.addNode({ id: "runtime", kind: "module" });
    graph.addEdge({ from: "runtime", to: "safety" });

    assert.deepEqual(graph.getPlan(), {
      nodes: [{ id: "runtime", kind: "module" }],
      edges: [{ from: "runtime", to: "safety" }],
    });
  });

  it("orders dependencies before dependent commands", () => {
    const graph = new OrchestrationGraph([
      { id: "complete", command: completeTask, dependsOn: ["create"] },
      { id: "create", command: createTask },
    ]);

    assert.deepEqual(
      graph.orderedNodes().map((node) => node.id),
      ["create", "complete"],
    );
  });

  it("rejects duplicate node IDs", () => {
    assert.throws(
      () =>
        new OrchestrationGraph([
          { id: "task", command: createTask },
          { id: "task", command: completeTask },
        ]),
      /Duplicate orchestration node ID/,
    );
  });

  it("rejects missing dependencies", () => {
    assert.throws(
      () =>
        new OrchestrationGraph([
          { id: "complete", command: completeTask, dependsOn: ["missing"] },
        ]),
      /depends on unknown node missing/,
    );
  });

  it("freezes validated nodes and command inputs against caller mutation", () => {
    const mutableCommand = {
      operationId: "createTask" as const,
      input: { title: "Inspect mounts" },
    };
    const graph = new OrchestrationGraph([
      { id: "create", command: mutableCommand },
    ]);
    const [node] = graph.orderedNodes();

    assert.ok(node);
    assert.equal(Object.isFrozen(node), true);
    assert.equal(Object.isFrozen(node.command), true);
    assert.equal(Object.isFrozen(node.command.input), true);
    assert.throws(() => Reflect.set(node, "weight", 1), TypeError);
    assert.throws(
      () => Reflect.set(node.command.input, "title", "mutated"),
      TypeError,
    );
    assert.equal(mutableCommand.input.title, "Inspect mounts");
  });

  it("rejects invalid node weights", () => {
    assert.throws(
      () =>
        new OrchestrationGraph([
          { id: "invalid", command: createTask, weight: Number.NaN },
        ]),
      /invalid weight/,
    );
  });

  it("rejects cycles", () => {
    assert.throws(
      () =>
        new OrchestrationGraph([
          { id: "one", command: createTask, dependsOn: ["two"] },
          { id: "two", command: completeTask, dependsOn: ["one"] },
        ]),
      /contains a cycle/,
    );
  });
});

it("orders ready sibling nodes by descending weight while preserving dependencies", () => {
  const graph = new OrchestrationGraph([
    { id: "low", command: createTask, weight: 0.2 },
    { id: "high", command: completeTask, weight: 1 },
    {
      id: "dependent",
      command: { operationId: "createReminder", input: { title: "Later" } },
      weight: 0.1,
      dependsOn: ["low"],
    },
  ]);

  assert.deepEqual(
    graph.orderedNodes().map((node) => node.id),
    ["high", "low", "dependent"],
  );
});
