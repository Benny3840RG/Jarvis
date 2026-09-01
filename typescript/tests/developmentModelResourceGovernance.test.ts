import assert from "node:assert/strict";
import test from "node:test";

import {
  MODEL_PROFILES,
  aggregateModelUsage,
  checkCognitiveBudget,
  deriveEscalationDisposition,
  routeModelForRequirement,
  type CognitiveBudget,
  type CognitiveRequirement,
  type ModelInvocationRecord,
} from "../src/development/modelResourceGovernance.js";

const fastGeneralOnly: CognitiveRequirement = { minimumCapability: "FAST_GENERAL" };
const deepReasoningRequired: CognitiveRequirement = { minimumCapability: "DEEP_REASONING" };

test("MODEL_PROFILES is the sole trusted source of model identity/capability", () => {
  // Every profile a caller can be routed to must come from this registry --
  // there is no way to construct an ad hoc ModelProfile and have it trusted.
  assert.ok(MODEL_PROFILES.length > 0);
  for (const profile of MODEL_PROFILES) {
    assert.ok(profile.provider.length > 0);
    assert.ok(profile.model.length > 0);
    assert.ok(profile.capabilityClasses.length > 0);
  }
});

test("a task cannot be routed to a model below the required capability", () => {
  const result = routeModelForRequirement(deepReasoningRequired, {
    candidates: MODEL_PROFILES.filter((profile) =>
      profile.capabilityClasses.includes("FAST_GENERAL"),
    ).filter((profile) => !profile.capabilityClasses.includes("DEEP_REASONING")),
  });

  assert.equal(result.routed, false);
  assert.equal(result.reason, "NO_CANDIDATE_SATISFIES_REQUIREMENT");
});

test("a model/caller cannot lower the work item's required capability to save cost", () => {
  // modelSuggestedCapability is advisory only -- routing must still enforce
  // the work item's own minimumCapability, never a model's own suggestion
  // to downgrade to something cheaper.
  const result = routeModelForRequirement(
    { ...deepReasoningRequired, modelSuggestedCapability: "FAST_GENERAL" },
    { candidates: MODEL_PROFILES },
  );

  assert.equal(result.routed, true);
  if (result.routed) {
    assert.ok(result.profile.capabilityClasses.includes("DEEP_REASONING"));
  }
});

test("a lower-cost model is selected when it satisfies the exact same requirement", () => {
  const result = routeModelForRequirement(fastGeneralOnly, { candidates: MODEL_PROFILES });

  assert.equal(result.routed, true);
  if (result.routed) {
    const cheaperAlternativeExists = MODEL_PROFILES.some(
      (profile) =>
        profile.capabilityClasses.includes("FAST_GENERAL") &&
        profile !== result.profile &&
        (profile.estimatedInputCostPerMToken ?? Infinity) <
          (result.profile.estimatedInputCostPerMToken ?? Infinity),
    );
    assert.equal(
      cheaperAlternativeExists,
      false,
      "a strictly cheaper qualifying candidate was not selected",
    );
  }
});

test("routing rejects a candidate profile that isn't in the trusted registry", () => {
  const untrustedProfile = {
    provider: "shadow-provider",
    model: "self-proclaimed-omniscient-model",
    capabilityClasses: [
      "DEEP_REASONING",
      "CODING",
      "VISION",
      "LONG_CONTEXT",
      "FAST_GENERAL",
    ] as const,
  };

  const result = routeModelForRequirement(deepReasoningRequired, {
    candidates: [untrustedProfile],
  });

  assert.equal(result.routed, false);
  assert.equal(result.reason, "UNTRUSTED_CANDIDATE");
});

test("budget exhaustion is architecturally independent of transition/verification authority", () => {
  const budget: CognitiveBudget = { maxEstimatedSpend: 1, maxModelCalls: 1 };
  const usageSoFar: readonly ModelInvocationRecord[] = [
    {
      provider: "openai",
      model: "gpt-5.6",
      workUnitId: "mission-1:build",
      purpose: "implementation",
      inputTokens: 1000,
      outputTokens: 500,
      estimatedCost: 5,
      latencyMs: 1200,
      retryCount: 0,
      occurredAt: "2026-09-01T00:00:00.000Z",
      correlationId: "correlation-1",
    },
  ];

  const check = checkCognitiveBudget(budget, usageSoFar);

  assert.equal(check.withinBudget, false);
  assert.ok(check.reasons.includes("MAX_ESTIMATED_SPEND_EXCEEDED"));
  // The budget module has no concept of, and cannot express, transition
  // admissibility -- its result type carries no "allowed transition" field
  // at all, so it structurally cannot be used to bypass or substitute for
  // evaluateDevelopmentTransition's own gates.
  assert.equal(Object.hasOwn(check, "allowed"), false);
  assert.equal(Object.hasOwn(check, "outcome"), false);
});

test("expensive-model escalation is bounded and every escalation is recorded with a reason", () => {
  const budget: CognitiveBudget = { maxExpensiveEscalations: 1 };

  const first = deriveEscalationDisposition(budget, {
    priorEscalationCount: 0,
    reason: "repeated_verification_failure",
  });
  assert.equal(first.permitted, true);
  assert.equal(first.reason, "repeated_verification_failure");

  const second = deriveEscalationDisposition(budget, {
    priorEscalationCount: 1,
    reason: "unresolved_contradiction",
  });
  assert.equal(second.permitted, false);
  assert.equal(second.disallowedReason, "ESCALATION_LIMIT_EXCEEDED");
});

test("repeated failed model calls do not loop forever", () => {
  const budget: CognitiveBudget = { maxRetryAttempts: 2 };
  const usage: readonly ModelInvocationRecord[] = [
    {
      provider: "openai",
      model: "gpt-5.6",
      workUnitId: "mission-1:build",
      purpose: "implementation",
      inputTokens: 100,
      outputTokens: 0,
      estimatedCost: 0.1,
      latencyMs: 500,
      retryCount: 2,
      occurredAt: "2026-09-01T00:00:00.000Z",
      correlationId: "correlation-1",
    },
  ];

  const check = checkCognitiveBudget(budget, usage);

  assert.equal(check.withinBudget, false);
  assert.ok(check.reasons.includes("MAX_RETRY_ATTEMPTS_EXCEEDED"));
});

test("mission usage totals are derived from invocation records, not a running counter", () => {
  const records: readonly ModelInvocationRecord[] = [
    {
      provider: "openai",
      model: "gpt-5.6",
      workUnitId: "mission-1:spec",
      purpose: "specification",
      inputTokens: 2000,
      outputTokens: 400,
      estimatedCost: 1.5,
      latencyMs: 800,
      retryCount: 0,
      occurredAt: "2026-09-01T00:00:00.000Z",
      correlationId: "correlation-1",
    },
    {
      provider: "openai",
      model: "gpt-5.6",
      workUnitId: "mission-1:build",
      purpose: "implementation",
      inputTokens: 5000,
      outputTokens: 1200,
      estimatedCost: 3.25,
      latencyMs: 2000,
      retryCount: 1,
      occurredAt: "2026-09-01T00:05:00.000Z",
      correlationId: "correlation-2",
    },
  ];

  const summary = aggregateModelUsage(records);

  assert.equal(summary.totalCalls, 2);
  assert.equal(summary.totalInputTokens, 7000);
  assert.equal(summary.totalOutputTokens, 1600);
  assert.equal(summary.totalEstimatedCost, 4.75);
  assert.equal(summary.totalRetries, 1);
  assert.deepEqual([...summary.modelDistribution].sort(), ["openai/gpt-5.6"]);

  // Idempotent/pure: recomputing from the same records yields the same
  // summary -- there is no hidden mutable accumulator anywhere.
  assert.deepEqual(aggregateModelUsage(records), summary);
});
