import assert from "node:assert/strict";
import { describe, it } from "node:test";

import type { ConvexClientLike } from "../src/persistence/convexPersistence.js";
import {
  ConvexTotalityJournal,
  reasoningJournalFunctions,
} from "../src/persistence/convexTotalityJournal.js";

function fakeClient(capture: { functionRef?: unknown; args?: unknown }): ConvexClientLike {
  return {
    async query() {
      return null;
    },
    async mutation(functionRef: unknown, args: unknown) {
      capture.functionRef = functionRef;
      capture.args = args;
      return {
        validationReportId: "validation-1",
        auditEventId: "audit-1",
      };
    },
  } as unknown as ConvexClientLike;
}

describe("ConvexTotalityJournal", () => {
  it("commits validation and audit through one Convex mutation", async () => {
    const capture: { functionRef?: unknown; args?: unknown } = {};
    const journal = new ConvexTotalityJournal(fakeClient(capture), "service-token");

    await journal.commitOutcome({
      requestId: "request-1",
      projectId: "project-1",
      report: {
        passed: true,
        checks: [{ id: "CHECK", status: "pass" }],
        warnings: [],
        blockingFailures: [],
      },
      eventType: "totality.reasoning.completed",
      actor: "agent",
      payload: { responseId: "response-1" },
    });

    assert.equal(capture.functionRef, reasoningJournalFunctions.commit);
    assert.deepEqual(capture.args, {
      serviceToken: "service-token",
      requestId: "request-1",
      projectKey: "project-1",
      report: {
        passed: true,
        checks: [{ id: "CHECK", status: "pass" }],
        warnings: [],
        blockingFailures: [],
      },
      event: {
        eventType: "totality.reasoning.completed",
        actor: "agent",
        payload: { responseId: "response-1" },
      },
    });
  });
});
