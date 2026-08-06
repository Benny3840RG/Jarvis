import assert from "node:assert/strict";
import { describe, it } from "node:test";

import { redactCommissioningLog, RedactionError } from "../scripts/redact-commissioning-log.mjs";

describe("commissioning log redaction", () => {
  it("redacts known credentials and rejects residual credential-shaped data", () => {
    const redacted = redactCommissioningLog(
      "Authorization: Bearer secret-token\nOPENAI_API_KEY=sk-proj-secret-value",
      ["secret-token", "sk-proj-secret-value"],
    );
    assert.match(redacted, /Bearer \[REDACTED\]/);
    assert.doesNotMatch(redacted, /secret-token|sk-proj-secret-value/);
  });

  it("fails closed instead of returning an incompletely redacted log", () => {
    assert.throws(
      () => redactCommissioningLog("provider leaked -----BEGIN PRIVATE KEY-----", []),
      (error: unknown) => error instanceof RedactionError,
    );
  });
});
