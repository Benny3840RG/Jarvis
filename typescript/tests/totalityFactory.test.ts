import assert from "node:assert/strict";
import { afterEach, beforeEach, describe, it } from "node:test";

import {
  createTotalityPipelineFromEnv,
  resolveTotalityReasonerProviderName,
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
