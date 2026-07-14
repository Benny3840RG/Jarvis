import type { MemoryChangeSetService } from "./memoryChangeSets.js";
import { ConvexMemoryChangeSetService } from "../persistence/convexMemoryChangeSets.js";
import { resolvePersistenceProviderName } from "../persistence/providerSelection.js";

export function createMemoryChangeSetServiceFromEnv(): MemoryChangeSetService | null {
  if (resolvePersistenceProviderName() !== "convex") return null;
  return new ConvexMemoryChangeSetService();
}
