import assert from "node:assert/strict";
import { describe, it } from "node:test";

import { z } from "zod";

import type { ToolAction } from "../src/actions/toolActions.js";
import {
  fingerprintToolAction,
  ToolExecutionService,
  type ToolExecutionReceipt,
  type ToolExecutionReceiptStore,
} from "../src/actions/toolExecution.js";

const baseAction: ToolAction = {
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
  proposedBy: "agent",
  approvedBy: "user",
  createdAt: "2026-07-24T00:00:00.000Z",
  updatedAt: "2026-07-24T00:00:00.000Z",
  approvedAt: "2026-07-24T00:00:00.000Z",
};

class RecordingReceiptStore implements ToolExecutionReceiptStore {
  readonly records = new Map<string, ToolExecutionReceipt>();
  readonly saves: Array<{ key: string; receipt: ToolExecutionReceipt }> = [];

  async get(key: string): Promise<ToolExecutionReceipt | null> {
    return this.records.get(key) ?? null;
  }

  async save(key: string, receipt: ToolExecutionReceipt): Promise<void> {
    this.records.set(key, receipt);
    this.saves.push({ key, receipt });
  }
}

function clockDefinition() {
  return {
    tool: "clock",
    operation: "read",
    schema: z.object({ zone: z.string() }),
    async execute() {
      return { now: "2026-07-24T00:00:00.000Z" };
    },
  };
}

describe("internal action execution hardening", () => {
  it("produces the same versioned fingerprint for semantically equivalent object key order", () => {
    const first = fingerprintToolAction({
      ...baseAction,
      arguments: { zone: "UTC", options: { second: 2, first: 1 } },
    });
    const second = fingerprintToolAction({
      ...baseAction,
      arguments: { options: { first: 1, second: 2 }, zone: "UTC" },
    });

    assert.equal(first, second);
    assert.match(first, /^jarvis-action-fingerprint:v1:[a-f0-9]{64}$/);
  });

  it("changes the fingerprint when action content changes", () => {
    const first = fingerprintToolAction(baseAction);
    const changed = fingerprintToolAction({
      ...baseAction,
      arguments: { zone: "Australia/Melbourne" },
    });

    assert.notEqual(first, changed);
  });

  it("fails closed when action arguments contain unsupported JSON values", () => {
    assert.throws(
      () =>
        fingerprintToolAction({
          ...baseAction,
          arguments: { zone: "UTC", unsupported: undefined },
        }),
      /Canonical JSON rejects values of type undefined/,
    );
  });

  it("persists blocked and dry-run decisions with execution metadata", async () => {
    const store = new RecordingReceiptStore();
    const executor = new ToolExecutionService([clockDefinition()], store);

    const blocked = await executor.execute({
      action: baseAction,
      authority: "T0",
      idempotencyKey: "blocked-1",
      approvalId: "approval-1",
      policyVersion: "totality-policy:v2.2",
      correlationId: "correlation-1",
      source: "commissioning-test",
    });
    const dryRun = await executor.execute({
      action: baseAction,
      authority: "T1",
      idempotencyKey: "dry-run-1",
      dryRun: true,
      approvalId: "approval-2",
      policyVersion: "totality-policy:v2.2",
      correlationId: "correlation-2",
      source: "commissioning-test",
    });

    assert.equal(blocked.status, "blocked");
    assert.equal(blocked.errorCode, "not-authorized");
    assert.equal(dryRun.status, "dry-run");
    assert.deepEqual(
      store.saves.map(({ receipt }) => receipt.status),
      ["blocked", "dry-run"],
    );
    assert.equal(blocked.requestId, baseAction.requestId);
    assert.equal(blocked.actor, "agent");
    assert.equal(blocked.approvalId, "approval-1");
    assert.equal(blocked.policyVersion, "totality-policy:v2.2");
    assert.equal(blocked.correlationId, "correlation-1");
    assert.equal(blocked.source, "commissioning-test");

    for (const { key, receipt } of store.saves) {
      assert.deepEqual(await store.get(key), receipt);
    }
  });

  it("scopes replay keys by owner-backed project and action identity", async () => {
    let executions = 0;
    const executor = new ToolExecutionService([
      {
        ...clockDefinition(),
        async execute() {
          executions += 1;
          return { now: "2026-07-24T00:00:00.000Z" };
        },
      },
    ]);

    const first = await executor.execute({
      action: baseAction,
      authority: "T1",
      idempotencyKey: "shared",
    });
    const otherProject = await executor.execute({
      action: { ...baseAction, projectId: "project-2" },
      authority: "T1",
      idempotencyKey: "shared",
    });

    assert.equal(first.status, "succeeded");
    assert.equal(otherProject.status, "succeeded");
    assert.equal(executions, 2);
  });
});
