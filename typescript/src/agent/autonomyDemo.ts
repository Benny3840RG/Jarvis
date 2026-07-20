import type { AgentSystem } from "./system.js";
import type { ZStateReport } from "./zState.js";

export interface AutonomyDemoReport {
  /** Autonomy evaluated before any history is accrued (expected to be gated). */
  beforeWarmup: ZStateReport;
  /** Number of successful interactions recorded to warm up the adaptive history. */
  warmupInteractions: number;
  /** Autonomy evaluated after warmup (expected to activate and propose). */
  afterWarmup: ZStateReport;
}

/**
 * Demonstrates governed autonomy end to end: the Z-state gate refuses to activate
 * without enough adaptive history, then activates and returns advisory proposals
 * once enough safe, healthy, successful interactions exist. Proposals are never
 * applied — activation only unlocks suggestions.
 */
export function runGovernedAutonomyDemo(
  system: AgentSystem,
  warmupInteractions = 5,
): AutonomyDemoReport {
  const intent = "start_job";
  const parsed = system.conversation.parse("start job j1");
  const nodes = system.orchestrator.plan(parsed).steps.map((step) => ({
    module: step.module,
    action: step.action,
    weight: step.weight,
  }));

  const beforeWarmup = system.zState.canActivate(intent, nodes, system.learning.getHistory());

  for (let round = 0; round < warmupInteractions; round += 1) {
    system.learning.record(intent, true);
  }

  const afterWarmup = system.zState.canActivate(intent, nodes, system.learning.getHistory());

  return { beforeWarmup, warmupInteractions, afterWarmup };
}
