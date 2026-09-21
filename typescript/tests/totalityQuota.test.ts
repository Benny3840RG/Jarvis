import assert from "node:assert/strict";
import { describe, it } from "node:test";

import {
  TotalityQuota,
  TotalityQuotaError,
  type TotalityQuotaConfig,
} from "../src/totality/totalityQuota.js";
import type { TotalityRequest } from "../src/runtime/totalityContracts.js";

const CONFIG: TotalityQuotaConfig = {
  maxRequestBytes: 1_000,
  maxEstimatedInputTokens: 250,
  maxConcurrentRequests: 1,
  maxCostUnitsPerWindow: 600,
  maxOutputTokens: 100,
  windowMs: 1_000,
};

function request(overrides: Partial<TotalityRequest> = {}): TotalityRequest {
  return {
    requestId: "request-1",
    projectId: null,
    sessionId: "session-1",
    taskType: "general_analysis",
    domainContext: ["operations"],
    goal: "Check the system.",
    constraints: [],
    inputs: [],
    outputStyle: "default",
    actionPolicy: {
      maximumToolAuthority: "T1",
      requireApprovalBeforeExecution: true,
    },
    ...overrides,
  };
}

describe("Totality provider quota", () => {
  it("rejects oversized aggregate request fields before provider dispatch", () => {
    const quota = new TotalityQuota(CONFIG);
    assert.throws(
      () => quota.acquire(request({ goal: "x".repeat(2_000) })),
      (error: unknown) => error instanceof TotalityQuotaError && error.code === "request-too-large",
    );
  });

  it("independently bounds the incoming request when the provider body is smaller", () => {
    const quota = new TotalityQuota(CONFIG);

    assert.throws(
      () => quota.acquire(request({ goal: "x".repeat(2_000) }), "{}"),
      (error: unknown) => error instanceof TotalityQuotaError && error.code === "request-too-large",
    );
  });

  it("bounds the complete provider body by UTF-8 bytes without reserving rejected work", () => {
    const quota = new TotalityQuota({ ...CONFIG, maxCostUnitsPerWindow: 350 });

    assert.throws(
      () => quota.acquire(request(), "é".repeat(501)),
      (error: unknown) => error instanceof TotalityQuotaError && error.code === "request-too-large",
    );

    const lease = quota.acquire(request(), "é".repeat(500));
    lease.release();
    assert.throws(
      () => quota.acquire(request(), "é".repeat(500)),
      (error: unknown) =>
        error instanceof TotalityQuotaError && error.code === "provider-cost-quota",
    );
  });

  it("estimates provider input tokens from the complete serialized body", () => {
    const quota = new TotalityQuota({ ...CONFIG, maxEstimatedInputTokens: 200 });

    assert.throws(
      () => quota.acquire(request(), "x".repeat(801)),
      (error: unknown) => error instanceof TotalityQuotaError && error.code === "input-token-limit",
    );
    quota.acquire(request(), "x".repeat(800)).release();
  });

  it("reserves the cost of the complete provider body on every accepted call", () => {
    const quota = new TotalityQuota(CONFIG);
    quota.acquire(request(), "x".repeat(800)).release();
    quota.acquire(request(), "x".repeat(800)).release();

    assert.throws(
      () => quota.acquire(request(), "x".repeat(800)),
      (error: unknown) =>
        error instanceof TotalityQuotaError && error.code === "provider-cost-quota",
    );
  });

  it("bounds concurrent provider calls and reserves aggregate cost units", () => {
    const quota = new TotalityQuota(CONFIG);
    const lease = quota.acquire(request());
    assert.throws(
      () => quota.acquire(request({ requestId: "request-2" })),
      (error: unknown) => error instanceof TotalityQuotaError && error.code === "concurrency-limit",
    );
    lease.release();

    assert.throws(
      () => {
        const first = quota.acquire(request());
        first.release();
        const second = quota.acquire(request({ requestId: "request-2" }));
        second.release();
        quota.acquire(request({ requestId: "request-3" }));
      },
      (error: unknown) =>
        error instanceof TotalityQuotaError && error.code === "provider-cost-quota",
    );
  });
});
