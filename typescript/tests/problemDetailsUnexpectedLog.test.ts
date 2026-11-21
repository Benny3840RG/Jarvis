import assert from "node:assert/strict";
import { describe, it } from "node:test";

import type { HttpAppConfig } from "../src/http/config.js";
import { unexpectedErrorLogLine } from "../src/http/problemDetails.js";

const SERVICE = "service-token-0123456789abcdef0123456789abcdef";
const APPROVAL = "approval-token-0123456789abcdef0123456789abcdef";
const OTHER = "delivery-token-not-in-config-0123456789abcdef";

const CONFIG: HttpAppConfig = {
  version: "0.1.0",
  sourceVersion: "test",
  deploymentVersion: null,
  timezone: "Australia/Melbourne",
  currentToken: SERVICE,
  previousToken: undefined,
  currentApprovalToken: APPROVAL,
};

describe("unexpected 5xx log line", () => {
  it("names the cause of a 500 without any credential", () => {
    // The shape of a real Convex ArgumentValidationError, which dumps its arguments.
    const error = new Error(
      `[Request ID: 88fe] Server Error\nArgumentValidationError: Object contains extra field \`executionId\` that is not in the validator.\n\nObject: {actionId: "a-1", deliveryToken: "${OTHER}", serviceToken: "${SERVICE}", approval: "${APPROVAL}"}`,
    );
    const line = unexpectedErrorLogLine(
      error,
      500,
      "POST",
      `/api/v1/x?token=${SERVICE}`,
      "req-1",
      CONFIG,
    );
    assert.ok(line);
    assert.match(line, /500 POST/);
    assert.match(line, /req-1/);
    assert.match(line, /extra field `executionId`/);
    for (const secret of [SERVICE, APPROVAL, OTHER]) {
      assert.equal(line.includes(secret), false, "no credential reaches the log");
    }
  });

  it("stays quiet for expected client errors and bounds the length", () => {
    assert.equal(unexpectedErrorLogLine(new Error("nope"), 404, "GET", "/x", "r", CONFIG), null);
    const long = unexpectedErrorLogLine(
      new Error("x".repeat(10_000)),
      503,
      "GET",
      "/x",
      "r",
      CONFIG,
    );
    assert.ok(long && long.length <= 2_200);
  });
});
