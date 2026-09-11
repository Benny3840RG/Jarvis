import { ConvexDevelopmentLiveWorkSource } from "../persistence/convexDevelopmentLiveWork.js";
import { resolvePersistenceProviderName } from "../persistence/providerSelection.js";
import type { DevelopmentLiveWorkSource } from "./liveWork.js";

/**
 * The live-work pipeline reads authoritative Development/Omega state that only
 * exists under the Convex persistence provider. Returns `null` for the JSON
 * provider so the HTTP controller can report an honest "unavailable" rather
 * than fabricate an empty pipeline.
 */
export function createDevelopmentLiveWorkSourceFromEnv(): DevelopmentLiveWorkSource | null {
  if (
    resolvePersistenceProviderName() !== "convex" ||
    !process.env.CONVEX_URL ||
    !process.env.JARVIS_SERVICE_TOKEN
  )
    return null;
  return new ConvexDevelopmentLiveWorkSource();
}
