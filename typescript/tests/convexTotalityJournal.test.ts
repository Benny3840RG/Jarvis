import assert from "node:assert/strict";
import { describe, it } from "node:test";

import type { ConvexClientLike } from "../src/persistence/convexPersistence.js";
import { ConvexTotalityJournal } from "../src/persistence/convexTotalityJournal.js";

type Capture = {
  queryCalls: number;
  mutationCalls: number;
  queryFunctionRef?: unknown;
  queryArgs?: unknown;
  mutationFunctionRef?: unknown;
  mutationArgs?: unknown;
};

function fakeClient(capture: Capture): ConvexClientLike {
  return {
    async query(functionRef: unknown, args: unknown) {
      capture.queryCalls += 1;
      capture.queryFunctionRef = functionRef;
      capture.queryArgs = args;
      return {
        projectKey: "project-1",
        projectName: "Bracket review",
        projectType: "engineering",
        status: "active",
        revision: 4,
        domains: ["mechanical"],
        summary: "Review a fabricated bracket.",
        updatedAt: Date.parse("2026-07-15T23:00:00.000Z"),
      };
    },
    async mutation(functionRef: unknown, args: unknown) {
      capture.mutationCalls += 1;
      capture.mutationFunctionRef = functionRef;
      capture.mutationArgs = args;
      return {
        validationReportId: "validation-1",
        auditEventId: "audit-1",
        memoryChangeSetId: "reasoning-change-1",
      };
    },
  } as unknown as ConvexClientLike;
}

function capture(): Capture {
  return { queryCalls: 0, mutationCalls: 0 };
}

describe("ConvexTotalityJournal", () => {
  it("loads authoritative project context through the indexed project query", async () => {
    const calls = capture();
    const journal = new ConvexTotalityJournal(fakeClient(calls), "service-token");

    const project = await journal.getProjectContext("project-1");

    assert.equal(calls.queryCalls, 1);
    assert.notEqual(calls.queryFunctionRef, undefined);
    assert.deepEqual(calls.queryArgs, {
      serviceToken: "service-token",
      projectKey: "project-1",
    });
    assert.deepEqual(project, {
      projectId: "project-1",
      projectName: "Bracket review",
      projectType: "engineering",
      status: "active",
      revision: 4,
      domains: ["mechanical"],
      summary: "Review a fabricated bracket.",
      updatedAt: "2026-07-15T23:00:00.000Z",
    });
  });

  it("commits validation, audit and staged memory through one Convex mutation", async () => {
    const calls = capture();
    const journal = new ConvexTotalityJournal(fakeClient(calls), "service-token");

    const result = await journal.commitOutcome({
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
      memoryProposal: {
        changeSetId: "reasoning-change-1",
        expectedRevision: 4,
        rationale: "Retain the supplied thickness for explicit approval.",
        records: [
          {
            kind: "measurement",
            recordId: "reasoning-measurement-1",
            name: "Bracket thickness",
            value: 6,
            unit: "mm",
            source: "request input",
          },
        ],
      },
    });

    assert.equal(calls.mutationCalls, 1);
    assert.notEqual(calls.mutationFunctionRef, undefined);
    assert.deepEqual(calls.mutationArgs, {
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
      memoryProposal: {
        changeSetId: "reasoning-change-1",
        expectedRevision: 4,
        rationale: "Retain the supplied thickness for explicit approval.",
        records: [
          {
            kind: "measurement",
            recordId: "reasoning-measurement-1",
            name: "Bracket thickness",
            value: 6,
            unit: "mm",
            source: "request input",
          },
        ],
      },
    });
    assert.deepEqual(result, { memoryChangeSetId: "reasoning-change-1" });
  });
});
