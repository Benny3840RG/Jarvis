import assert from "node:assert/strict";
import { describe, it } from "node:test";

import { ConvexQuoteRepository } from "../src/quotes/convexQuoteRepository.js";
import type { ConvexClientLike } from "../src/persistence/convexPersistence.js";
import {
  QuoteFinalizedImmutableError,
  QuoteFingerprintMismatchError,
  QuoteInvalidTransitionError,
  QuoteVersionConflictError,
} from "../src/quotes/quoteLifecycle.js";

const serviceToken = "quote-adapter-contract-token";

function clientThatThrows(error: Error): ConvexClientLike {
  return {
    async query() {
      throw error;
    },
    async mutation() {
      throw error;
    },
  } as unknown as ConvexClientLike;
}

describe("ConvexQuoteRepository contract", () => {
  it("accepts the approved options-object constructor", async () => {
    const client = {
      async query() {
        return null;
      },
      async mutation() {
        throw new Error("mutation should not be called");
      },
    } as unknown as ConvexClientLike;

    const repository = new ConvexQuoteRepository({ client, serviceToken });
    assert.equal(await repository.getQuote("missing-quote"), null);
  });

  it("restores serialized Convex lifecycle failures to typed domain errors", async () => {
    const cases = [
      ["QuoteVersionConflictError", QuoteVersionConflictError],
      ["QuoteInvalidTransitionError", QuoteInvalidTransitionError],
      ["QuoteFinalizedImmutableError", QuoteFinalizedImmutableError],
      ["QuoteFingerprintMismatchError", QuoteFingerprintMismatchError],
    ] as const;

    for (const [name, ErrorType] of cases) {
      const serialized = new Error(`Server Error Uncaught ${name}: preserved details`);
      const repository = new ConvexQuoteRepository({
        client: clientThatThrows(serialized),
        serviceToken,
      });

      await assert.rejects(
        repository.submitForReview({
          quoteId: "quote-1",
          revision: 2,
          expectedAggregateVersion: 4,
          expectedRevisionVersion: 3,
        }),
        ErrorType,
      );
    }
  });

  it("rethrows unknown transport failures unchanged", async () => {
    const outage = new Error("Convex transport closed unexpectedly");
    const repository = new ConvexQuoteRepository({
      client: clientThatThrows(outage),
      serviceToken,
    });

    await assert.rejects(repository.getQuote("quote-1"), (error: unknown) => error === outage);
  });
});
