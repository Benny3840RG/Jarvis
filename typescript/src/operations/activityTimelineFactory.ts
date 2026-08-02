import { ConvexActivityEventReader } from "../persistence/convexActivityEvents.js";
import { resolvePersistenceProviderName } from "../persistence/providerSelection.js";
import type { ActivityEventReader } from "./activityTimeline.js";

export function createActivityEventReaderFromEnv(): ActivityEventReader | null {
  if (resolvePersistenceProviderName() !== "convex") return null;
  return new ConvexActivityEventReader();
}
