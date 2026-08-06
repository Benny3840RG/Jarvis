import assert from "node:assert/strict";
import { describe, it } from "node:test";

import type { TotalityRequest } from "../src/runtime/totalityContracts.js";
import {
  TotalityPipeline,
  type TotalityJournal,
  type TotalityProjectContext,
  type TotalityReasoner,
} from "../src/totality/totalityPipeline.js";
import { TotalityQuota, type TotalityQuotaConfig } from "../src/totality/totalityQuota.js";

const PROPOSED_AT = "2026-07-16T00:00:00.000Z";

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

function makeProject(): TotalityProjectContext {
  return {
    projectId: "project-1",
    projectName: "Bracket review",
    projectType: "engineering",
    status: "active",
    revision: 4,
    domains: ["mechanical"],
    summary: "Review a fabricated steel bracket.",
    updatedAt: "2026-07-15T23:00:00.000Z",
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
          memoryProposals: [],
          memoryRationale: "",
          ...overrides,
        },
      };
    },
  };
}

function makeJournal(project: TotalityProjectContext | null = makeProject()): TotalityJournal & {
  outcomes: Array<{
    eventType: string;
    validationPassed: boolean;
    memoryProposalCount: number;
  }>;
} {
  const outcomes: Array<{
    eventType: string;
    validationPassed: boolean;
    memoryProposalCount: number;
  }> = [];
  return {
    outcomes,
    async getProjectContext() {
      return project;
    },
    async commitOutcome(input) {
      outcomes.push({
        eventType: input.eventType,
        validationPassed: input.report.passed,
        memoryProposalCount: input.memoryProposal?.records.length ?? 0,
      });
      return {
        memoryChangeSetId:
          input.memoryProposal === undefined ? null : input.memoryProposal.changeSetId,
      };
    },
  };
}

function makePipeline(
  reasoner: TotalityReasoner,
  journal: TotalityJournal,
  quota?: TotalityQuota,
): TotalityPipeline {
  return new TotalityPipeline(reasoner, journal, () => new Date(PROPOSED_AT), quota);
}

describe("TotalityPipeline", () => {
  it("returns a completed proposal only after atomic journalling", async () => {
    const journal = makeJournal();
    const pipeline = makePipeline(makeReasoner(), journal);

    const response = await pipeline.run(makeRequest());

    assert.equal(response.status, "completed");
    assert.match(response.result?.answer ?? "", /gusset/);
    assert.equal(response.result?.memoryChangeSetId, null);
    assert.equal(response.result?.memoryProposalCount, 0);
    assert.deepEqual(response.memoryUpdates, []);
    assert.deepEqual(response.toolActions, []);
    assert.deepEqual(journal.outcomes, [
      {
        eventType: "totality.reasoning.completed",
        validationPassed: true,
        memoryProposalCount: 0,
      },
    ]);
  });

  it("atomically stages locally validated memory proposals against the project revision", async () => {
    const journal = makeJournal();
    const pipeline = makePipeline(
      makeReasoner({
        memoryProposals: [
          {
            kind: "assumption",
            statement: "The peak bracket load has not been verified.",
            impact: "high",
          },
          {
            kind: "measurement",
            name: "Bracket thickness",
            value: 6,
            unit: "mm",
            tolerance: null,
            source: "request input",
          },
        ],
        memoryRationale: "Retain the unresolved load assumption and supplied bracket thickness.",
      }),
      journal,
    );

    const response = await pipeline.run(makeRequest());

    assert.equal(response.status, "completed");
    assert.equal(response.result?.memoryProposalCount, 2);
    assert.match(response.result?.memoryChangeSetId ?? "", /^reasoning-/);
    assert.equal(response.memoryUpdates.length, 2);
    assert.ok(response.memoryUpdates.every((update) => update.requiresApproval));
    assert.equal(response.memoryUpdates[0]?.classification, "assumption");
    assert.equal(response.memoryUpdates[1]?.classification, "measurement");
    assert.deepEqual(journal.outcomes, [
      {
        eventType: "totality.reasoning.completed",
        validationPassed: true,
        memoryProposalCount: 2,
      },
    ]);
  });

  it("blocks invalid model memory proposals before durable staging", async () => {
    const journal = makeJournal();
    const pipeline = makePipeline(
      makeReasoner({
        memoryProposals: [
          {
            kind: "fact",
            statement: "The bracket is safe for all service loads.",
            source: "inference",
            confidence: 1,
          },
        ],
        memoryRationale: "Remember the conclusion.",
      }),
      journal,
    );

    const response = await pipeline.run(makeRequest());

    assert.equal(response.status, "blocked");
    assert.equal(response.result, null);
    assert.deepEqual(response.memoryUpdates, []);
    assert.ok(
      response.validation.blockingFailures.some((failure) =>
        /inferred fact as authoritative/i.test(failure),
      ),
    );
    assert.deepEqual(journal.outcomes, [
      {
        eventType: "totality.reasoning.blocked",
        validationPassed: false,
        memoryProposalCount: 0,
      },
    ]);
  });

  it("blocks memory proposals when no project scope exists", async () => {
    const journal = makeJournal(null);
    const request = makeRequest();
    request.projectId = null;
    const pipeline = makePipeline(
      makeReasoner({
        memoryProposals: [
          {
            kind: "assumption",
            statement: "A project would be required to retain this.",
            impact: "low",
          },
        ],
        memoryRationale: "Attempt to retain an unscoped assumption.",
      }),
      journal,
    );

    const response = await pipeline.run(request);

    assert.equal(response.status, "blocked");
    assert.equal(response.result, null);
    assert.deepEqual(response.memoryUpdates, []);
    assert.ok(
      response.validation.blockingFailures.includes(
        "Reasoning memory proposals require an authoritative project context.",
      ),
    );
  });

  it("fails before reasoning when the requested project does not exist", async () => {
    let called = false;
    const reasoner: TotalityReasoner = {
      async reason() {
        called = true;
        return makeReasoner().reason(makeRequest(), { project: null, proposedAt: PROPOSED_AT });
      },
    };
    const pipeline = makePipeline(reasoner, makeJournal(null));

    await assert.rejects(() => pipeline.run(makeRequest()), /Project context does not exist/);
    assert.equal(called, false);
  });

  it("blocks the answer but atomically records validation and audit evidence", async () => {
    const journal = makeJournal();
    const pipeline = makePipeline(
      makeReasoner({ unsupportedClaims: ["The bracket is certified for 10 kN."] }),
      journal,
    );

    const response = await pipeline.run(makeRequest());

    assert.equal(response.status, "blocked");
    assert.equal(response.result, null);
    assert.equal(response.validation.passed, false);
    assert.ok(response.errors.some((error) => error.code === "VALIDATION_BLOCKED"));
    assert.deepEqual(journal.outcomes, [
      {
        eventType: "totality.reasoning.blocked",
        validationPassed: false,
        memoryProposalCount: 0,
      },
    ]);
  });

  it("fails closed when the atomic journal commit fails", async () => {
    const journal: TotalityJournal = {
      async getProjectContext() {
        return makeProject();
      },
      async commitOutcome() {
        throw new Error("Convex unavailable");
      },
    };
    const pipeline = makePipeline(makeReasoner(), journal);

    await assert.rejects(() => pipeline.run(makeRequest()), /Convex unavailable/);
  });

  it("blocks authority violations before reading project context or calling the reasoner", async () => {
    let reasonerCalled = false;
    let projectCalled = false;
    const reasoner: TotalityReasoner = {
      async reason() {
        reasonerCalled = true;
        return makeReasoner().reason(makeRequest(), {
          project: makeProject(),
          proposedAt: PROPOSED_AT,
        });
      },
    };
    const journal = makeJournal();
    journal.getProjectContext = async () => {
      projectCalled = true;
      return makeProject();
    };
    const pipeline = makePipeline(reasoner, journal);
    const request = makeRequest();
    request.actionPolicy.maximumToolAuthority = "T0";

    await assert.rejects(() => pipeline.run(request), /exceeds the request action policy/);
    assert.equal(reasonerCalled, false);
    assert.equal(projectCalled, false);
  });

  it("does not reserve provider quota for requests rejected before provider dispatch", async () => {
    const quotaConfig: TotalityQuotaConfig = {
      maxRequestBytes: 10_000,
      maxEstimatedInputTokens: 2_500,
      maxConcurrentRequests: 1,
      maxCostUnitsPerWindow: 1_000,
      maxOutputTokens: 100,
      windowMs: 60_000,
    };
    const quota = new TotalityQuota(quotaConfig);
    const pipeline = makePipeline(makeReasoner(), makeJournal(), quota);
    const unauthorizedRequest = makeRequest();
    unauthorizedRequest.actionPolicy.maximumToolAuthority = "T0";

    await assert.rejects(
      () => pipeline.run(unauthorizedRequest),
      /exceeds the request action policy/,
    );
    const response = await pipeline.run(makeRequest());

    assert.equal(response.status, "completed");
  });
});
