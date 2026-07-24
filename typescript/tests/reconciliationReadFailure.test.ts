import assert from "node:assert/strict";
import { describe, it } from "node:test";

import { z } from "zod";

import {
  InMemoryToolExecutionReceiptStore,
  ToolExecutionService,
  type ToolExecutionDefinition,
} from "../src/actions/toolExecution.js";
import type { ToolAction } from "../src/actions/toolActions.js";
import type { ExternalReconciliationStore } from "../src/reconciliation/externalReconciliation.js";

function action(): ToolAction {
  return {
    actionId: "action-read-failure",
    requestId: "request-read-failure",
    projectId: "project-read-failure",
    baseRevision: 1,
    state: "approved",
    tool: "quotes",
    operation: "send",
    arguments: { body: "Quote body" },
    rationale: "Exercise reconciliation replay lookup.",
    requiredAuthority: "T2",
    destructive: false,
    idempotencyKey: "proposal-read-failure",
    proposedBy: "agent",
    approvedBy: "user",
    createdAt: "2026-07-24T00:00:00.000Z",
    updatedAt: "2026-07-24T00:00:00.000Z",
    approvedAt: "2026-07-24T00:00:00.000Z",
  };
}

function definition(executions: { count: number }): ToolExecutionDefinition {
  return {
    tool: "quotes",
    operation: "send",
    externalProvider: "demo-provider",
    schema: z.object({ body: z.string().min(1) }),
    async execute() {
      executions.count += 1;
      return { shouldNotRun: true };
    },
  };
}

function failingStore(error: Error): ExternalReconciliationStore {
  return {
    async getByScope() {
      throw error;
    },
  } as unknown as ExternalReconciliationStore;
}

describe("external reconciliation replay read failures", () => {
  it("keeps a known effect-fingerprint collision classified as fingerprint-mismatch", async () => {
    const executions = { count: 0 };
    const service = new ToolExecutionService(
      [definition(executions)],
      new InMemoryToolExecutionReceiptStore(),
      failingStore(new Error("External execution scope belongs to another effect fingerprint.")),
    );

    const result = await service.execute({
      action: action(),
      authority: "T2",
      idempotencyKey: "external-read-collision",
    });

    assert.equal(result.status, "blocked");
    assert.equal(result.errorCode, "fingerprint-mismatch");
    assert.equal(executions.count, 0);
  });

  it("classifies an arbitrary reconciliation-store outage without pretending it is a collision", async () => {
    const executions = { count: 0 };
    const service = new ToolExecutionService(
      [definition(executions)],
      new InMemoryToolExecutionReceiptStore(),
      failingStore(new Error("Convex network unavailable")),
    );

    const result = await service.execute({
      action: action(),
      authority: "T2",
      idempotencyKey: "external-read-outage",
    });

    assert.equal(result.status, "blocked");
    assert.equal(result.errorCode, "reconciliation-unavailable");
    assert.equal(executions.count, 0);
  });
});
