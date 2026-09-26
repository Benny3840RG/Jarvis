import assert from "node:assert/strict";
import { describe, it } from "node:test";

import {
  correlationOf,
  isSensitiveTelemetryKey,
  REDACTED,
  reconstructMissionChain,
  redactTelemetryAttributes,
  TELEMETRY_CORRELATION_FIELDS,
} from "../src/observability/telemetryContract.js";

describe("telemetry correlation fields", () => {
  it("are unique", () => {
    assert.equal(new Set(TELEMETRY_CORRELATION_FIELDS).size, TELEMETRY_CORRELATION_FIELDS.length);
  });

  it("are never treated as sensitive keys", () => {
    for (const field of TELEMETRY_CORRELATION_FIELDS) {
      assert.equal(isSensitiveTelemetryKey(field), false, field);
    }
  });

  it("extracts only the correlation ids that are present", () => {
    const attributes = {
      missionId: "m1",
      runId: "r1",
      workerBuildId: "jarvis-temporal-pass.abc",
      unrelated: "x",
      candidateSha: undefined,
    };
    assert.deepEqual(correlationOf(attributes), {
      missionId: "m1",
      runId: "r1",
      workerBuildId: "jarvis-temporal-pass.abc",
    });
  });
});

describe("mission chain reconstruction", () => {
  it("joins only the events sharing the given missionId, in order, with their correlation ids", () => {
    const events = [
      { missionId: "m1", workflowId: "w1", stage: "request" },
      { missionId: "m2", workflowId: "w9", stage: "request" },
      { missionId: "m1", workflowId: "w1", runId: "r1", toolCallId: "t1", stage: "tool" },
      { stage: "no-mission" },
      { missionId: "m1", workflowId: "w1", runId: "r1", effectId: "e1", stage: "effect" },
    ];
    const chain = reconstructMissionChain(events, "m1");
    assert.deepEqual(
      chain.map((link) => link.event.stage),
      ["request", "tool", "effect"],
    );
    assert.deepEqual(chain[0]?.correlation, { missionId: "m1", workflowId: "w1" });
    assert.deepEqual(chain[2]?.correlation, {
      missionId: "m1",
      workflowId: "w1",
      runId: "r1",
      effectId: "e1",
    });
    // A different mission's events and an unattributed event are never swept in.
    assert.equal(
      chain.some((link) => link.event.stage === "no-mission" || link.event.missionId === "m2"),
      false,
    );
  });

  it("returns an empty chain when no event names the mission", () => {
    assert.deepEqual(reconstructMissionChain([{ missionId: "m1" }, { stage: "x" }], "m2"), []);
  });
});

describe("telemetry redaction", () => {
  it("flags sensitive keys and clears benign ones", () => {
    for (const key of [
      "token",
      "serviceToken",
      "JARVIS_APPROVAL_TOKEN",
      "clientSecret",
      "password",
      "passwd",
      "credential",
      "apiKey",
      "api_key",
      "authorization",
      "bearer",
      "cookie",
      "systemPrompt",
      "toolArguments",
      "args",
      "userEmail",
    ]) {
      assert.equal(isSensitiveTelemetryKey(key), true, key);
    }
    for (const key of ["missionId", "durationMs", "outcome", "tool", "status", "provider"]) {
      assert.equal(isSensitiveTelemetryKey(key), false, key);
    }
  });

  it("masks sensitive values while preserving correlation and benign fields", () => {
    const input = {
      missionId: "m1",
      tool: "github.pull_request_read",
      durationMs: 831,
      serviceToken: "supersecret",
      prompt: "the full model prompt",
      outcome: "success",
    };
    const redacted = redactTelemetryAttributes(input);
    assert.deepEqual(redacted, {
      missionId: "m1",
      tool: "github.pull_request_read",
      durationMs: 831,
      serviceToken: REDACTED,
      prompt: REDACTED,
      outcome: "success",
    });
    // Input is not mutated.
    assert.equal(input.serviceToken, "supersecret");
  });

  it("masks a sensitive subtree whole and recurses into benign nested objects", () => {
    const redacted = redactTelemetryAttributes({
      credentials: { token: "a", refresh: "b" },
      request: { toolCallId: "t1", authorization: "Bearer xyz", path: "/api/v1/status" },
      items: [{ apiKey: "k" }, { runId: "r1" }],
    });
    assert.deepEqual(redacted, {
      credentials: REDACTED,
      request: { toolCallId: "t1", authorization: REDACTED, path: "/api/v1/status" },
      items: [{ apiKey: REDACTED }, { runId: "r1" }],
    });
  });
});
