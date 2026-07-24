import assert from "node:assert/strict";
import { describe, it } from "node:test";

import { categorizeGeminiRequestError } from "../src/integrations/gemini/errorCategory.js";
import { GeminiRequestError } from "../src/integrations/gemini/totalityReasoner.js";

describe("Gemini error categorisation", () => {
  it("classifies persistent quota and billing failures safely", () => {
    const error = new GeminiRequestError(
      "Resource has been exhausted (e.g. check quota).",
      429,
      false,
    );

    assert.equal(categorizeGeminiRequestError(error), "quota_exhausted");
  });

  it("keeps ordinary 429 responses in the temporary rate-limit category", () => {
    const error = new GeminiRequestError("Rate limit reached for requests per minute.", 429, true);

    assert.equal(categorizeGeminiRequestError(error), "rate_limited");
  });

  it("classifies non-429 failures as dependency failures", () => {
    const error = new GeminiRequestError("Upstream unavailable.", 503, true);

    assert.equal(categorizeGeminiRequestError(error), "dependency_failed");
  });
});
