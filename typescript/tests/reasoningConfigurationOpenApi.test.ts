import assert from "node:assert/strict";
import fs from "node:fs/promises";
import { describe, it } from "node:test";

type JsonSchema = {
  oneOf?: JsonSchema[];
  required?: string[];
  properties?: Record<string, { const?: string; enum?: string[] }>;
};

describe("reasoning configuration OpenAPI contract", () => {
  it("requires `reasoning` on SystemStatus and refs the ReasoningConfigurationStatus schema", async () => {
    const contract = JSON.parse(
      await fs.readFile(new URL("../openapi/jarvis.openapi.json", import.meta.url), "utf8"),
    ) as {
      components: {
        schemas: Record<string, JsonSchema & { properties?: Record<string, unknown> }>;
      };
    };

    const systemStatus = contract.components.schemas.SystemStatus;
    assert.ok(systemStatus.required?.includes("reasoning"));
    assert.deepEqual(
      (systemStatus.properties?.reasoning as { $ref?: string } | undefined)?.$ref,
      "#/components/schemas/ReasoningConfigurationStatus",
    );
  });

  it("bounds ReasoningConfigurationStatus to configured/not-configured, never a secret field", async () => {
    const contract = JSON.parse(
      await fs.readFile(new URL("../openapi/jarvis.openapi.json", import.meta.url), "utf8"),
    ) as { components: { schemas: Record<string, JsonSchema> } };

    const schema = contract.components.schemas.ReasoningConfigurationStatus;
    assert.equal(schema.oneOf?.length, 2);

    const configured = schema.oneOf?.find((branch) => branch.required?.includes("provider"));
    assert.ok(configured);
    assert.equal(configured?.properties?.status.const, "configured");
    assert.equal(configured?.properties?.observability?.const, "configuration-only");
    assert.deepEqual(
      new Set(Object.keys(configured?.properties ?? {})),
      new Set(["status", "provider", "model", "observability"]),
    );

    const notConfigured = schema.oneOf?.find((branch) => branch.required?.includes("reason"));
    assert.ok(notConfigured);
    assert.equal(notConfigured?.properties?.status.const, "not-configured");
    assert.deepEqual(
      new Set(Object.keys(notConfigured?.properties ?? {})),
      new Set(["status", "reason"]),
    );
  });
});
