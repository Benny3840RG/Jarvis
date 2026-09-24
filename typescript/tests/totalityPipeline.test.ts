import assert from "node:assert/strict";
import { describe, it } from "node:test";

import type { TotalityRequest } from "../src/runtime/totalityContracts.js";
import { TotalityCallerDisconnected } from "../src/totality/callerLifetime.js";
import {
  TotalityPipeline,
  type TotalityJournal,
  type TotalityProjectContext,
  type TotalityReasoner,
  type TotalityReasoningContext,
} from "../src/totality/totalityPipeline.js";
import {
  TotalityQuota,
  TotalityQuotaError,
  type TotalityQuotaConfig,
} from "../src/totality/totalityQuota.js";

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
    serializeRequest(request, context) {
      return JSON.stringify({ request, context });
    },
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
  it("rejects an adapter without a wire serializer before dispatch or journalling", async () => {
    const journal = makeJournal();
    let reasonerCalls = 0;
    // Exercise a malformed adapter injected by an untyped caller.
    const reasoner = {
      async reason() {
        reasonerCalls += 1;
        return makeReasoner().reason(makeRequest(), {
          project: makeProject(),
          proposedAt: PROPOSED_AT,
        });
      },
    } as unknown as TotalityReasoner;

    await assert.rejects(
      () => makePipeline(reasoner, journal).run(makeRequest()),
      (error: unknown) => error instanceof TypeError && /serializeRequest/.test(error.message),
    );
    assert.equal(reasonerCalls, 0);
    assert.deepEqual(journal.outcomes, []);
  });

  it("rejects oversized stored project context before provider dispatch or journal commit", async () => {
    const project = { ...makeProject(), summary: "x".repeat(2_000) };
    const journal = makeJournal(project);
    let reasonerCalls = 0;
    const reasoner: TotalityReasoner = {
      serializeRequest: makeReasoner().serializeRequest,
      async reason(request, context) {
        reasonerCalls += 1;
        return makeReasoner().reason(request, context);
      },
    };
    const quota = new TotalityQuota({
      maxRequestBytes: 1_000,
      maxEstimatedInputTokens: 250,
      maxConcurrentRequests: 1,
      maxCostUnitsPerWindow: 350,
      maxOutputTokens: 100,
      windowMs: 60_000,
    });
    const pipeline = makePipeline(reasoner, journal, quota);

    await assert.rejects(
      () => pipeline.run(makeRequest()),
      (error: unknown) => error instanceof TotalityQuotaError && error.code === "request-too-large",
    );
    assert.equal(reasonerCalls, 0);
    assert.deepEqual(journal.outcomes, []);

    project.summary = "A short project summary.";
    assert.equal((await pipeline.run(makeRequest())).status, "completed");
    assert.equal(reasonerCalls, 1);
    assert.equal(journal.outcomes.length, 1);
  });

  it("budgets the provider serializer including instructions and schema before dispatch", async () => {
    const journal = makeJournal();
    let reasonerCalls = 0;
    let serializationCalls = 0;
    const reasoner: TotalityReasoner = {
      serializeRequest(request, context) {
        serializationCalls += 1;
        return JSON.stringify({ request, context, instructions: "x".repeat(2_000), schema: {} });
      },
      async reason(request, context) {
        reasonerCalls += 1;
        return makeReasoner().reason(request, context);
      },
    };
    const pipeline = makePipeline(
      reasoner,
      journal,
      new TotalityQuota({
        maxRequestBytes: 1_000,
        maxEstimatedInputTokens: 250,
        maxConcurrentRequests: 1,
        maxCostUnitsPerWindow: 1_000,
        maxOutputTokens: 100,
        windowMs: 60_000,
      }),
    );

    await assert.rejects(
      () => pipeline.run(makeRequest()),
      (error: unknown) => error instanceof TotalityQuotaError && error.code === "request-too-large",
    );
    assert.equal(serializationCalls, 1);
    assert.equal(reasonerCalls, 0);
    assert.deepEqual(journal.outcomes, []);
  });

  it("uses the same project, timestamp and output limit for budgeting and dispatch", async () => {
    let serializedContext: TotalityReasoningContext | undefined;
    const reasoner: TotalityReasoner = {
      serializeRequest(request, context) {
        serializedContext = context;
        return JSON.stringify({ request, context });
      },
      async reason(request, context) {
        assert.equal(context, serializedContext);
        assert.equal(context.proposedAt, PROPOSED_AT);
        assert.equal(context.maxOutputTokens, 4_096);
        assert.deepEqual(context.project, makeProject());
        return makeReasoner().reason(request, context);
      },
    };

    const response = await makePipeline(reasoner, makeJournal()).run(makeRequest());
    assert.equal(response.status, "completed");
  });

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
      serializeRequest: makeReasoner().serializeRequest,
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
      serializeRequest: makeReasoner().serializeRequest,
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

  it("rejects a delegation that does not say whether it is durable", async () => {
    const pipeline = makePipeline(makeReasoner(), makeJournal());
    await assert.rejects(
      () =>
        pipeline.run(makeRequest(), {
          delegations: [{ durable: undefined as unknown as boolean, async run() {} }],
        }),
      /durable to true or false/,
    );
    assert.equal(pipeline.detachedDurableWork.length, 0);
  });

  it("does not admit durable work when the caller is already gone", async () => {
    const caller = new AbortController();
    caller.abort();
    let durableStarted = false;
    let reasoned = false;
    const reasoner = makeReasoner();
    const pipeline = makePipeline(
      {
        serializeRequest: reasoner.serializeRequest,
        async reason(request, context, signal) {
          reasoned = true;
          return reasoner.reason(request, context, signal);
        },
      },
      makeJournal(),
    );

    await assert.rejects(
      () =>
        pipeline.run(makeRequest(), {
          signal: caller.signal,
          delegations: [
            {
              durable: true,
              async run() {
                durableStarted = true;
              },
            },
          ],
        }),
      (error: unknown) => error instanceof TotalityCallerDisconnected,
    );
    assert.equal(reasoned, false);
    assert.equal(durableStarted, false);
    assert.equal(pipeline.detachedDurableWork.length, 0);
  });

  it("cancels request-bound work on caller disconnect and leaves admitted durable work running", async () => {
    const caller = new AbortController();
    const quota = new TotalityQuota({
      maxRequestBytes: 100_000,
      maxEstimatedInputTokens: 25_000,
      maxConcurrentRequests: 1,
      maxCostUnitsPerWindow: 100_000,
      maxOutputTokens: 100,
      windowMs: 60_000,
    });
    let committed = false;
    let reasonerSignal: AbortSignal | undefined;
    let requestBoundSignal: AbortSignal | undefined;
    let durableSignal: AbortSignal | undefined;
    let durableStarted = false;
    let durableFinished = false;
    let releaseDurable: () => void = () => {};
    const durableGate = new Promise<void>((resolve) => {
      releaseDurable = resolve;
    });
    const journal = makeJournal();
    journal.commitOutcome = async () => {
      committed = true;
      return { memoryChangeSetId: null };
    };
    const reasoner = makeReasoner();
    const pipeline = makePipeline(
      {
        serializeRequest: reasoner.serializeRequest,
        async reason(request, context, signal) {
          if (!signal) return reasoner.reason(request, context);
          reasonerSignal = signal;
          await new Promise((_resolve, reject) => {
            if (signal.aborted) {
              reject(new TotalityCallerDisconnected());
              return;
            }
            signal.addEventListener("abort", () => reject(new TotalityCallerDisconnected()), {
              once: true,
            });
          });
          return reasoner.reason(request, context);
        },
      },
      journal,
      quota,
    );

    const running = pipeline.run(makeRequest(), {
      signal: caller.signal,
      delegations: [
        {
          durable: true,
          async run(signal) {
            durableStarted = true;
            durableSignal = signal;
            await durableGate;
            durableFinished = true;
          },
        },
        {
          durable: false,
          async run(signal) {
            requestBoundSignal = signal;
            await new Promise((_resolve, reject) => {
              signal?.addEventListener("abort", () => reject(new TotalityCallerDisconnected()), {
                once: true,
              });
            });
          },
        },
      ],
    });
    await new Promise<void>((resolve, reject) => {
      let stopped = false;
      const timer = setTimeout(() => {
        stopped = true;
        reject(
          new Error(
            `reasoner did not start (reasoner=${Boolean(reasonerSignal)} bound=${Boolean(requestBoundSignal)} durable=${durableStarted})`,
          ),
        );
      }, 1_000);
      const wait = () => {
        if (stopped) return;
        if (reasonerSignal && requestBoundSignal && durableStarted) {
          stopped = true;
          clearTimeout(timer);
          resolve();
          return;
        }
        setTimeout(wait, 10);
      };
      wait();
    });

    caller.abort();
    await assert.rejects(running, (error: unknown) => error instanceof TotalityCallerDisconnected);
    assert.equal(committed, false);
    assert.equal(reasonerSignal?.aborted, true);
    assert.equal(requestBoundSignal, caller.signal);
    assert.equal(requestBoundSignal?.aborted, true);
    assert.equal(durableSignal, undefined);
    assert.equal(durableFinished, false);

    releaseDurable();
    await pipeline.detachedDurableWork[0];
    assert.equal(durableFinished, true);

    const followUp = await pipeline.run(makeRequest());
    assert.equal(followUp.status, "completed");
  });

  it("returns the turn without waiting for or cancelling admitted durable work", async () => {
    let releaseDurable: () => void = () => {};
    const durableGate = new Promise<void>((resolve) => {
      releaseDurable = resolve;
    });
    let finished = false;
    const pipeline = makePipeline(makeReasoner(), makeJournal());
    const response = await pipeline.run(makeRequest(), {
      delegations: [
        {
          durable: true,
          async run(signal) {
            assert.equal(signal, undefined);
            await durableGate;
            finished = true;
          },
        },
      ],
    });

    assert.equal(response.status, "completed");
    assert.equal(finished, false);
    releaseDurable();
    await pipeline.detachedDurableWork[0];
    assert.equal(finished, true);
  });

  it("keeps a durable failure on the detached job when the turn itself succeeds", async () => {
    const pipeline = makePipeline(makeReasoner(), makeJournal());
    const response = await pipeline.run(makeRequest(), {
      delegations: [
        {
          durable: true,
          async run() {
            throw new Error("background index failed");
          },
        },
      ],
    });

    assert.equal(response.status, "completed");
    await assert.rejects(pipeline.detachedDurableWork[0], /background index failed/);
  });

  it("finishes a journal commit that has already started after the caller disconnects", async () => {
    const caller = new AbortController();
    let releaseCommit: () => void = () => {};
    let commitStarted: () => void = () => {};
    const started = new Promise<void>((resolve) => {
      commitStarted = resolve;
    });
    const gate = new Promise<void>((resolve) => {
      releaseCommit = resolve;
    });
    let committed = false;
    const journal = makeJournal();
    journal.commitOutcome = async () => {
      commitStarted();
      await gate;
      committed = true;
      return { memoryChangeSetId: null };
    };
    const pipeline = makePipeline(makeReasoner(), journal);
    const pending = pipeline.run(makeRequest(), { signal: caller.signal });
    await Promise.race([
      started,
      new Promise((_resolve, reject) =>
        setTimeout(() => reject(new Error("journal commit did not start")), 1_000),
      ),
    ]);
    caller.abort();
    releaseCommit();
    const response = await pending;

    assert.equal(response.status, "completed");
    assert.equal(committed, true);
    assert.equal(caller.signal.aborted, true);
  });
});
