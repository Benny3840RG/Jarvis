import assert from "node:assert/strict";
import { describe, it } from "node:test";

import type { TotalityRequest } from "../src/runtime/totalityContracts.js";
import {
  TotalityPipeline,
  type TotalityJournal,
  type TotalityReasoner,
} from "../src/totality/totalityPipeline.js";

function makeRequest(): TotalityRequest {
  return {
    requestId: "request-1",
    projectId: "project-1",
    sessionId: "session-1",
    taskType: "engineering_analysis",
    domainContext: ["mechanical"],
    goal: "Review a bracket",
    constraints: [],
    inputs: [],
    outputStyle: "for_benny_engineering",
    actionPolicy: {
      maximumToolAuthority: "T1",
      requireApprovalBeforeExecution: true,
    },
  };
}

function makeReasoner(
  overrides: Partial<Awaited<ReturnType<TotalityReasoner["reason"]>>["draft"]> = {},
): TotalityReasoner {
  return {
    async reason() {
      return {
        responseId: "response-1",
        draft: {
          answer: "Use a gusset and verify the load path.",
          assumptions: ["Steel grade is unverified."],
          unknowns: ["Peak load is unknown."],
          risks: ["Weld fatigue."],
          controls: ["Proof-load and inspect the weld profile."],
          unsupportedClaims: [],
          contradictions: [],
          ...overrides,
        },
      };
    },
  };
}

function makeJournal(): TotalityJournal & {
  outcomes: Array<{ eventType: string; validationPassed: boolean }>;
} {
  const outcomes: Array<{ eventType: string; validationPassed: boolean }> = [];
  return {
    outcomes,
    async commitOutcome(input) {
      outcomes.push({
        eventType: input.eventType,
        validationPassed: input.report.passed,
      });
    },
  };
}

describe("TotalityPipeline", () => {
  it("returns a completed proposal only after atomic journalling", async () => {
    const journal = makeJournal();
    const pipeline = new TotalityPipeline(makeReasoner(), journal);

    const response = await pipeline.run(makeRequest());

    assert.equal(response.status, "completed");
    assert.match(response.result?.answer ?? "", /gusset/);
    assert.deepEqual(response.memoryUpdates, []);
    assert.deepEqual(response.toolActions, []);
    assert.deepEqual(journal.outcomes, [
      { eventType: "totality.reasoning.completed", validationPassed: true },
    ]);
  });

  it("blocks the answer but atomically records validation and audit evidence", async () => {
    const journal = makeJournal();
    const pipeline = new TotalityPipeline(
      makeReasoner({ unsupportedClaims: ["The bracket is certified for 10 kN."] }),
      journal,
    );

    const response = await pipeline.run(makeRequest());

    assert.equal(response.status, "blocked");
    assert.equal(response.result, null);
    assert.equal(response.validation.passed, false);
    assert.ok(response.errors.some((error) => error.code === "VALIDATION_BLOCKED"));
    assert.deepEqual(journal.outcomes, [
      { eventType: "totality.reasoning.blocked", validationPassed: false },
    ]);
  });

  it("fails closed when the atomic journal commit fails", async () => {
    const journal: TotalityJournal = {
      async commitOutcome() {
        throw new Error("Convex unavailable");
      },
    };
    const pipeline = new TotalityPipeline(makeReasoner(), journal);

    await assert.rejects(() => pipeline.run(makeRequest()), /Convex unavailable/);
  });

  it("blocks authority violations before calling the reasoner", async () => {
    let called = false;
    const reasoner: TotalityReasoner = {
      async reason() {
        called = true;
        return makeReasoner().reason(makeRequest());
      },
    };
    const pipeline = new TotalityPipeline(reasoner, makeJournal());
    const request = makeRequest();
    request.actionPolicy.maximumToolAuthority = "T0";

    await assert.rejects(() => pipeline.run(request), /exceeds the request action policy/);
    assert.equal(called, false);
  });
});
