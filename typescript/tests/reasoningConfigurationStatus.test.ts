import assert from "node:assert/strict";
import { describe, it } from "node:test";

import { resolveReasoningConfigurationStatus } from "../src/totality/reasoningConfigurationStatus.js";

const CONVEX_OPENAI_ENV: NodeJS.ProcessEnv = {
  OPENAI_API_KEY: "sk-super-secret-value",
};

describe("resolveReasoningConfigurationStatus", () => {
  it("is not-configured when persistence is not convex, regardless of reasoner keys", () => {
    const status = resolveReasoningConfigurationStatus("json", CONVEX_OPENAI_ENV);
    assert.equal(status.status, "not-configured");
    assert.ok(status.status === "not-configured" && /Convex persistence/.test(status.reason));
  });

  it("is not-configured when TOTALITY_REASONER_PROVIDER is unrecognised", () => {
    const status = resolveReasoningConfigurationStatus("convex", {
      ...CONVEX_OPENAI_ENV,
      TOTALITY_REASONER_PROVIDER: "anthropic",
    });
    assert.equal(status.status, "not-configured");
  });

  it("is not-configured for the default openai provider without OPENAI_API_KEY", () => {
    const status = resolveReasoningConfigurationStatus("convex", {});
    assert.equal(status.status, "not-configured");
    assert.ok(
      status.status === "not-configured" && /OpenAI reasoning credentials/.test(status.reason),
    );
  });

  it("is not-configured for the gemini provider without GEMINI_API_KEY", () => {
    const status = resolveReasoningConfigurationStatus("convex", {
      TOTALITY_REASONER_PROVIDER: "gemini",
      OPENAI_API_KEY: "unrelated-to-gemini",
    });
    assert.equal(status.status, "not-configured");
    assert.ok(
      status.status === "not-configured" && /Gemini reasoning credentials/.test(status.reason),
    );
  });

  it("is not-configured when the configured model is not in the trusted registry", () => {
    const status = resolveReasoningConfigurationStatus("convex", {
      OPENAI_API_KEY: "sk-super-secret-value",
      OPENAI_MODEL: "some-untrusted-model",
    });
    assert.equal(status.status, "not-configured");
    assert.ok(status.status === "not-configured" && /trusted model registry/.test(status.reason));
  });

  it("is configured for the trusted default openai model with Convex persistence and an API key", () => {
    const status = resolveReasoningConfigurationStatus("convex", CONVEX_OPENAI_ENV);
    assert.deepEqual(status, {
      status: "configured",
      provider: "openai",
      model: "gpt-5.6-terra",
      observability: "configuration-only",
    });
  });

  it("is configured for the trusted gemini model when selected", () => {
    const status = resolveReasoningConfigurationStatus("convex", {
      TOTALITY_REASONER_PROVIDER: "gemini",
      GEMINI_API_KEY: "another-super-secret-value",
    });
    assert.deepEqual(status, {
      status: "configured",
      provider: "gemini",
      model: "gemini-2.5-flash",
      observability: "configuration-only",
    });
  });

  it("never leaks the API key into the projection, configured or not", () => {
    const configured = resolveReasoningConfigurationStatus("convex", CONVEX_OPENAI_ENV);
    const notConfigured = resolveReasoningConfigurationStatus("json", CONVEX_OPENAI_ENV);
    assert.doesNotMatch(JSON.stringify(configured), /sk-super-secret-value/);
    assert.doesNotMatch(JSON.stringify(notConfigured), /sk-super-secret-value/);
  });
});
