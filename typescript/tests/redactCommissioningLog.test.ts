import assert from "node:assert/strict";
import fs from "node:fs";
import { describe, it } from "node:test";
import { fileURLToPath } from "node:url";

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

  it("redacts basic credentials and arbitrary workflow secret assignments", () => {
    const redacted = redactCommissioningLog(
      "Authorization: Basic YWxpY2U6c2VjcmV0LWNyZWRlbnRpYWw=\nJARVIS_APPROVAL_TOKEN=approval-secret-value",
      [],
    );

    assert.match(redacted, /Authorization: Basic \[REDACTED\]/);
    assert.match(redacted, /JARVIS_APPROVAL_TOKEN=\[REDACTED\]/);
    assert.doesNotMatch(redacted, /YWxpY2U6c2VjcmV0|approval-secret-value/);
  });

  it("does not stream development commissioning output before redaction", () => {
    const workflowPath = fileURLToPath(
      new URL("../../.github/workflows/development-commissioning.yml", import.meta.url),
    );
    const workflow = fs.readFileSync(workflowPath, "utf8");

    assert.match(workflow, /npx convex dev --once --tail-logs disable >"\$sync_log" 2>&1/);
    assert.doesNotMatch(workflow, /npx convex dev --once --tail-logs disable 2>&1 \| tee/);
  });

  it("publishes only allowlisted diagnostics from queued commissioning logs", () => {
    const workflowPath = fileURLToPath(
      new URL("../../.github/workflows/queue-development-commissioning.yml", import.meta.url),
    );
    const workflow = fs.readFileSync(workflowPath, "utf8");

    const filterPosition = workflow.indexOf("grep -Ei 'error|failed|invalid");
    const publishPosition = workflow.indexOf('failed_log_excerpt="$(cat "$redacted_log")"');
    assert.ok(filterPosition >= 0 && filterPosition < publishPosition);
  });
});
