import { ConvexQuoteDeliveryRepository } from "../persistence/convexQuoteDeliveries.js";
import { resolvePersistenceProviderName } from "../persistence/providerSelection.js";
import type { QuoteDeliveryRepository } from "./quoteDeliveryRepository.js";

/**
 * The quote delivery ledger has only a Convex implementation, matching
 * `createQuoteRepositoryFromEnv` — there is no JSON/in-memory port. Callers
 * get `null` outside Convex and the HTTP layer responds 503, the same
 * pattern used for the quote lifecycle repository.
 */
export function createQuoteDeliveryRepositoryFromEnv(): QuoteDeliveryRepository | null {
  if (resolvePersistenceProviderName() !== "convex") return null;
  return new ConvexQuoteDeliveryRepository();
}
