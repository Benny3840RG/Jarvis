import assert from "node:assert/strict";
import { afterEach, beforeEach, describe, it } from "node:test";

import {
  createTotalityPipelineFromEnv,
  resolveTotalityReasonerProviderName,
  resolveTotalityReasoningStatus,
} from "../src/totality/totalityFactory.js";

describe("resolveTotalityReasonerProviderName", () => {
  it("defaults to openai when unset", () => {
    assert.equal(resolveTotalityReasonerProviderName(undefined), "openai");
    assert.equal(resolveTotalityReasonerProviderName(""), "openai");
  });

  it("accepts openai and gemini case-insensitively", () => {
    assert.equal(resolveTotalityReasonerProviderName("OpenAI"), "openai");
    assert.equal(resolveTotalityReasonerProviderName("GEMINI"), "gemini");
    assert.equal(resolveTotalityReasonerProviderName(" gemini "), "gemini");
  });

  it("rejects an unrecognised provider name", () => {
    assert.throws(
      () => resolveTotalityReasonerProviderName("anthropic"),
      /Invalid TOTALITY_REASONER_PROVIDER/,
    );
  });
});

describe("createTotalityPipelineFromEnv", () => {
  const keys = [
    "PERSISTENCE_PROVIDER",
    "TOTALITY_REASONER_PROVIDER",
    "OPENAI_API_KEY",
    "GEMINI_API_KEY",
  ] as const;
  const originalValues = new Map<string, string | undefined>();

  beforeEach(() => {
    for (const key of keys) {
      originalValues.set(key, process.env[key]);
      delete process.env[key];
    }
  });

  afterEach(() => {
    for (const key of keys) {
      const original = originalValues.get(key);
      if (original === undefined) delete process.env[key];
      else process.env[key] = original;
    }
  });

  it("returns null when persistence is not convex, regardless of reasoner keys", () => {
    process.env.OPENAI_API_KEY = "test-key";
    process.env.GEMINI_API_KEY = "test-key";
    assert.equal(createTotalityPipelineFromEnv(), null);
  });

  it("returns null for the default openai provider without OPENAI_API_KEY", () => {
    process.env.PERSISTENCE_PROVIDER = "convex";
    assert.equal(createTotalityPipelineFromEnv(), null);
  });

  it("returns null for the gemini provider without GEMINI_API_KEY", () => {
    process.env.PERSISTENCE_PROVIDER = "convex";
    process.env.TOTALITY_REASONER_PROVIDER = "gemini";
    process.env.OPENAI_API_KEY = "unrelated-to-gemini";
    assert.equal(createTotalityPipelineFromEnv(), null);
  });
});

describe("resolveTotalityReasoningStatus", () => {
  const keys = [
    "PERSISTENCE_PROVIDER",
    "TOTALITY_REASONER_PROVIDER",
    "OPENAI_API_KEY",
    "GEMINI_API_KEY",
    "OPENAI_MODEL",
    "GEMINI_MODEL",
  ] as const;
  const originalValues = new Map<string, string | undefined>();

  beforeEach(() => {
    for (const key of keys) {
      originalValues.set(key, process.env[key]);
      delete process.env[key];
    }
  });

  afterEach(() => {
    for (const key of keys) {
      const original = originalValues.get(key);
      if (original === undefined) delete process.env[key];
      else process.env[key] = original;
    }
  });

  it("reports not-configured with no provider when persistence is not convex", () => {
    process.env.OPENAI_API_KEY = "test-key";
    assert.deepEqual(resolveTotalityReasoningStatus(), {
      status: "not-configured",
      provider: null,
      model: null,
      reason: "Totality reasoning requires Convex persistence, which is not the active provider.",
    });
  });

  it("reports not-configured with the resolved provider when its API key is missing", () => {
    process.env.PERSISTENCE_PROVIDER = "convex";
    const status = resolveTotalityReasoningStatus();
    assert.equal(status.status, "not-configured");
    assert.equal(status.provider, "openai");
    assert.equal(status.model, null);
    assert.match(status.reason, /OPENAI_API_KEY is not set/);
  });

  it("reports configured with the default model for openai without ever claiming verification", () => {
    process.env.PERSISTENCE_PROVIDER = "convex";
    process.env.OPENAI_API_KEY = "test-key";
    assert.deepEqual(resolveTotalityReasoningStatus(), {
      status: "configured",
      provider: "openai",
      model: "gpt-5.6-terra",
      reason: "Configuration only -- invocation has not been verified with a live provider call.",
    });
  });

  it("reports configured with an explicit model for gemini", () => {
    process.env.PERSISTENCE_PROVIDER = "convex";
    process.env.TOTALITY_REASONER_PROVIDER = "gemini";
    process.env.GEMINI_API_KEY = "test-key";
    process.env.GEMINI_MODEL = "gemini-2.5-pro";
    const status = resolveTotalityReasoningStatus();
    assert.equal(status.status, "configured");
    assert.equal(status.provider, "gemini");
    assert.equal(status.model, "gemini-2.5-pro");
  });

  it("never includes the API key value anywhere in the reported status", () => {
    process.env.PERSISTENCE_PROVIDER = "convex";
    process.env.OPENAI_API_KEY = "sk-super-secret-do-not-leak";
    const status = resolveTotalityReasoningStatus();
    assert.doesNotMatch(JSON.stringify(status), /sk-super-secret-do-not-leak/);
  });

  it("reports an invalid provider as not-configured instead of throwing", () => {
    process.env.PERSISTENCE_PROVIDER = "convex";
    process.env.TOTALITY_REASONER_PROVIDER = "unsupported-provider";
    process.env.OPENAI_API_KEY = "sk-super-secret-do-not-leak";

    const status = resolveTotalityReasoningStatus();

    assert.deepEqual(status, {
      status: "not-configured",
      provider: null,
      model: null,
      reason: "TOTALITY_REASONER_PROVIDER is invalid.",
    });
    assert.doesNotMatch(JSON.stringify(status), /unsupported-provider|sk-super-secret-do-not-leak/);
  });

  it("reports an invalid OpenAI model as not-configured instead of throwing", () => {
    process.env.PERSISTENCE_PROVIDER = "convex";
    process.env.OPENAI_API_KEY = "test-key";
    process.env.OPENAI_MODEL = "invalid model";

    assert.deepEqual(resolveTotalityReasoningStatus(), {
      status: "not-configured",
      provider: "openai",
      model: null,
      reason: "OPENAI_MODEL is invalid.",
    });
  });

  it("reports an invalid Gemini model as not-configured instead of throwing", () => {
    process.env.PERSISTENCE_PROVIDER = "convex";
    process.env.TOTALITY_REASONER_PROVIDER = "gemini";
    process.env.GEMINI_API_KEY = "test-key";
    process.env.GEMINI_MODEL = "invalid model";

    assert.deepEqual(resolveTotalityReasoningStatus(), {
      status: "not-configured",
      provider: "gemini",
      model: null,
      reason: "GEMINI_MODEL is invalid.",
    });
  });
});
