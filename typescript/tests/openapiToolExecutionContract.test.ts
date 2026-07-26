import assert from "node:assert/strict";
import fs from "node:fs/promises";
import { describe, it } from "node:test";

describe("tool execution OpenAPI contract", () => {
  it("describes the active execution allowlist and includes the execute operation", async () => {
    const contract = JSON.parse(
      await fs.readFile(new URL("../openapi/jarvis.openapi.json", import.meta.url), "utf8"),
    ) as {
      info: { description: string };
      "x-chatgpt-app": { restOnlyOperationIds: string[] };
      paths: Record<string, Record<string, { operationId?: string; description?: string }>>;
    };

    const execute = contract.paths[
      "/api/v1/projects/{projectId}/tool-actions/{actionId}/execute"
    ]?.post;

    assert.equal(execute?.operationId, "executeToolAction");
    assert.ok(contract["x-chatgpt-app"].restOnlyOperationIds.includes("executeToolAction"));
    assert.match(contract.info.description, /approved tool actions may be executed/i);
    assert.match(execute?.description ?? "", /notes:create/);
    assert.match(execute?.description ?? "", /tasks:create/);
    assert.match(execute?.description ?? "", /reminders:cancel/);
    assert.doesNotMatch(execute?.description ?? "", /currently no tool\/operation is allowlisted/i);
  });
});
