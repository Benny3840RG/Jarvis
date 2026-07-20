import type { AgentSystem } from "./system.js";
import type { ExecutionPlan, OrchestrationResult } from "./orchestrator.js";
import type { ParsedInput } from "./conversationService.js";
import type { InteractionRecord } from "./learningEngine.js";
import type { MemorySnapshot } from "./memoryManager.js";
import type { LongTermMemoryEntry } from "./memoryTypes.js";
import type { ValidationResult } from "./validationSuite.js";

export interface SystemCheckReport {
  parsed: ParsedInput;
  plan: ExecutionPlan;
  execution: OrchestrationResult;
  learningHistory: InteractionRecord[];
  memoryConsolidation: LongTermMemoryEntry | null;
  memorySnapshot: MemorySnapshot;
  validation: ValidationResult[];
  allValid: boolean;
}

/**
 * Drives one representative scenario end to end and returns a structured report.
 * Used both by the runnable `agent:check` entry and the agent test suite.
 */
export async function runSystemCheck(
  system: AgentSystem,
  scenario = "Start job j1",
): Promise<SystemCheckReport> {
  const parsed = system.conversation.parse(scenario);
  const plan = system.orchestrator.plan(parsed);
  const execution = await system.orchestrator.execute(plan);

  system.learning.record(parsed.intent, execution.safety.status === "ok");
  system.memoryManager.addShortTerm(parsed.intent, parsed.entities);

  const learningHistory = system.learning.getHistory();
  const memoryConsolidation = system.memoryManager.consolidate(learningHistory);
  const memorySnapshot = system.memoryManager.snapshot();
  const validation = system.validation.runAll();

  return {
    parsed,
    plan,
    execution,
    learningHistory,
    memoryConsolidation,
    memorySnapshot,
    validation,
    allValid: validation.every((result) => result.passed),
  };
}
