import { resolvePersistenceProviderName } from "../persistence/providerSelection.js";
import { ConvexQuoteRepository } from "./convexQuoteRepository.js";
import type { QuoteRepository } from "./quoteRepository.js";

/**
 * The quote revision lifecycle has only a Convex implementation today (see
 * ConvexQuoteRepository) — there is no JSON/in-memory port, unlike the older
 * flat QuoteStore. Callers get `null` outside Convex and the HTTP layer
 * responds 503, the same pattern used for tool actions and memory change sets.
 */
export function createQuoteRepositoryFromEnv(): QuoteRepository | null {
  if (resolvePersistenceProviderName() !== "convex") return null;
  return new ConvexQuoteRepository();
}
