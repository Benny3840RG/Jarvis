import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { after, before, describe, it } from "node:test";

import type { MissionIntent } from "../../src/preview/temporalPass/types.js";
import { passWorkflow } from "../../src/preview/temporalPass/temporal/workflows/passWorkflow.js";
import { createPassTestEnv, type PassTestEnv } from "./helpers/testEnv.js";

// PASS-07: review/test loops stop at their configured bounds instead of
// looping forever (or until an external timeout) on a stuck mission.
describe("PASS-07 bounded review/test loops", () => {
  let env: PassTestEnv;

  before(async () => {
    env = await createPassTestEnv();
  });

  after(async () => {
    await env.teardown();
  });

  it("fails closed after exceeding the max review cycles", async () => {
    const missionId = `bounded-review-${randomUUID()}`;
    const intent: MissionIntent = {
      id: missionId,
      type: "SIMPLE_ACTION",
      description: "always requests changes",
      context: { repo: `repo-${missionId}` },
      scenario: { reviewChangesForCycles: 5 }, // exceeds MAX_REVIEW_CYCLES (3)
    };

    const handle = await env.testEnv.client.workflow.start(passWorkflow, {
      taskQueue: env.taskQueue,
      workflowId: missionId,
      args: [intent],
    });
    const result = await handle.result();

    assert.equal(result.status, "FAILED");
    assert.equal(result.failedStep, "REVIEW");
    assert.match(result.failureReason ?? "", /Exceeded max review cycles/);
    assert.ok(!result.completedSteps.includes("MERGE"));
  });

  it("fails closed after exceeding the max test repair cycles", async () => {
    const missionId = `bounded-test-${randomUUID()}`;
    const intent: MissionIntent = {
      id: missionId,
      type: "SIMPLE_ACTION",
      description: "always fails tests, repairably",
      context: { repo: `repo-${missionId}` },
      scenario: { testFailuresForCycles: 5 }, // exceeds MAX_TEST_CYCLES (2)
    };

    const handle = await env.testEnv.client.workflow.start(passWorkflow, {
      taskQueue: env.taskQueue,
      workflowId: missionId,
      args: [intent],
    });
    const result = await handle.result();

    assert.equal(result.status, "FAILED");
    assert.equal(result.failedStep, "TEST");
    assert.match(result.failureReason ?? "", /Exceeded max test repair cycles/);
    assert.ok(!result.completedSteps.includes("MERGE"));
  });

  it("fails closed immediately on an unrepairable test failure, without looping", async () => {
    const missionId = `unrepairable-test-${randomUUID()}`;
    const intent: MissionIntent = {
      id: missionId,
      type: "SIMPLE_ACTION",
      description: "unrepairable test failure",
      context: { repo: `repo-${missionId}` },
      scenario: { testFailuresForCycles: 5, testUnrepairable: true },
    };

    const handle = await env.testEnv.client.workflow.start(passWorkflow, {
      taskQueue: env.taskQueue,
      workflowId: missionId,
      args: [intent],
    });
    const result = await handle.result();

    assert.equal(result.status, "FAILED");
    assert.equal(result.failedStep, "TEST");
    assert.equal(result.iteration, 0);
  });
});
