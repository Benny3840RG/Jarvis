import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { describe, it } from "node:test";

type OpenApiOperation = {
  operationId?: string;
  "x-mcp-tool"?: { exposed?: boolean };
};

const document = JSON.parse(
  readFileSync(new URL("../openapi/jarvis.openapi.json", import.meta.url), "utf8"),
) as {
  "x-chatgpt-app": { restOnlyOperationIds: string[] };
  paths: Record<string, Record<string, OpenApiOperation>>;
};

const VOICE_OPERATION_IDS = [
  "listVoiceCatalog",
  "createVoiceSession",
  "endVoiceSession",
  "dispatchVoiceUtterance",
  "switchVoiceProfile",
] as const;

describe("voice OpenAPI metadata", () => {
  it("keeps every voice operation HTTP-only and inventoried as REST-only", () => {
    const restOnly = new Set(document["x-chatgpt-app"].restOnlyOperationIds);
    const voiceOperations = Object.entries(document.paths)
      .filter(([path]) => path.startsWith("/api/v1/voice"))
      .flatMap(([, item]) => Object.values(item));

    for (const operationId of VOICE_OPERATION_IDS) {
      assert.equal(
        restOnly.has(operationId),
        true,
        `${operationId} missing from REST-only metadata`,
      );
      const operation = voiceOperations.find((candidate) => candidate.operationId === operationId);
      assert.ok(operation, `${operationId} missing from voice paths`);
      assert.equal(
        operation["x-mcp-tool"]?.exposed,
        false,
        `${operationId} must not be MCP-exposed`,
      );
    }
  });
});
