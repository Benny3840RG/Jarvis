import { ConvexPersistence, type ConvexClientLike } from "./convexPersistence.js";
import { JSONPersistence } from "./jsonPersistence.js";
import type { PersistenceProvider } from "./types.js";

export type PersistenceProviderName = "json" | "convex";

export function resolvePersistenceProviderName(
  configured = process.env.PERSISTENCE_PROVIDER,
): PersistenceProviderName {
  const provider = (configured ?? "json").trim().toLowerCase();
  if (provider === "" || provider === "json") return "json";
  if (provider === "convex") return "convex";
  throw new Error(
    `Invalid PERSISTENCE_PROVIDER '${configured}'. Valid values: unset, json, convex.`,
  );
}

export function createPersistenceFromEnv(client?: ConvexClientLike): PersistenceProvider {
  return resolvePersistenceProviderName() === "json"
    ? new JSONPersistence()
    : new ConvexPersistence(client);
}
