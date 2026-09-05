import assert from "node:assert/strict";
import { describe, it } from "node:test";

import { categorizeOpenAIRequestError } from "../src/integrations/openai/errorCategory.js";
import { OpenAIRequestError } from "../src/integrations/openai/totalityReasoner.js";

describe("OpenAI error categorisation", () => {
  it("classifies persistent quota and billing failures safely", () => {
    const error = new OpenAIRequestError(
      "You exceeded your current quota. Check your plan and billing details.",
      429,
      false,
    );

    assert.equal(categorizeOpenAIRequestError(error), "quota_exhausted");
  });

  it("keeps ordinary 429 responses in the temporary rate-limit category", () => {
    const error = new OpenAIRequestError("Rate limit reached for requests per minute.", 429, true);

    assert.equal(categorizeOpenAIRequestError(error), "rate_limited");
  });

  it("distinguishes rejected credentials and requests from dependency failures", () => {
    assert.equal(
      categorizeOpenAIRequestError(new OpenAIRequestError("Invalid API key.", 401, false)),
      "authentication_failed",
    );
    assert.equal(
      categorizeOpenAIRequestError(new OpenAIRequestError("Request rejected.", 400, false)),
      "request_rejected",
    );

    const error = new OpenAIRequestError("Upstream unavailable.", 503, true);

    assert.equal(categorizeOpenAIRequestError(error), "dependency_failed");
  });
});
