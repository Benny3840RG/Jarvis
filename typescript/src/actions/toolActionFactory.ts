import { ConvexToolActionService } from "../persistence/convexToolActions.js";
import { resolvePersistenceProviderName } from "../persistence/providerSelection.js";
import type { ToolActionService } from "./toolActions.js";

export function createToolActionServiceFromEnv(): ToolActionService | null {
  if (resolvePersistenceProviderName() !== "convex") return null;
  return new ConvexToolActionService();
}
