import assert from "node:assert/strict";
import { describe, it } from "node:test";

import {
  correlationOf,
  isSensitiveTelemetryKey,
  REDACTED,
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
