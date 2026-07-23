import { ConvexToolExecutionReceiptStore } from "../persistence/convexToolExecutionReceipts.js";
import { resolvePersistenceProviderName } from "../persistence/providerSelection.js";
import { ToolExecutionService } from "./toolExecution.js";

/**
 * No tool:operation is registered yet — every execution attempt is blocked as
 * not-allowlisted until a specific, reviewed definition is added here. This is
 * deliberate: the executor is fully wired and durable, but nothing can cause a
 * side effect through it until that allowlist decision is made explicitly.
 */
export function createToolExecutionServiceFromEnv(): ToolExecutionService | null {
  if (resolvePersistenceProviderName() !== "convex") return null;
  return new ToolExecutionService([], new ConvexToolExecutionReceiptStore());
}
