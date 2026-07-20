import type { InteractionRecord, IntentStats } from "./learningEngine.js";
import type { OrchestrationNode } from "./graph.js";
import type { HealthMonitor } from "./healthMonitor.js";
import type { RuleChange, RuleEvolution } from "./ruleEvolution.js";
import type { SafetyEnvelope } from "./safetyEnvelope.js";
import type { WorkflowGenerator, WorkflowProposal } from "./workflowGenerator.js";

export interface ZStateProposals {
  workflow: WorkflowProposal;
  ruleChanges: RuleChange[];
}

export interface ZStateReport {
  active: boolean;
  reasons: string[];
  proposals?: ZStateProposals;
}

/**
 * Governs autonomy activation. Autonomy may only activate when reliability is
 * healthy, safety is satisfied, and enough adaptive history exists. When it does,
 * it returns advisory proposals — it never applies them.
 */
export class ZState {
  constructor(
    private readonly workflowGen: WorkflowGenerator,
    private readonly ruleEvolution: RuleEvolution,
    private readonly safety: SafetyEnvelope,
    private readonly health: HealthMonitor,
    private readonly getStats: () => IntentStats,
    private readonly minHistory = 5,
  ) {}

  canActivate(
    intent: string,
    nodes: OrchestrationNode[],
    history: InteractionRecord[],
  ): ZStateReport {
    const reasons: string[] = [];

    const healthStatus = this.health.overallStatus();
    if (healthStatus !== "ok") reasons.push(`Reliability status: ${healthStatus}`);

    const safetyCheck = this.safety.evaluate({
      domain: nodes[0]?.module ?? "unknown",
      action: nodes[0]?.action ?? "unknown",
      payload: {},
      outputs: [],
    });
    if (safetyCheck.status !== "ok") reasons.push("Safety envelope not satisfied");

    if (history.length < this.minHistory) reasons.push("Insufficient adaptive history");

    if (reasons.length > 0) return { active: false, reasons };

    const stats = this.getStats();
    return {
      active: true,
      reasons: [],
      proposals: {
        workflow: this.workflowGen.propose(intent, nodes, stats),
        ruleChanges: this.ruleEvolution.proposeRuleChanges(intent, stats),
      },
    };
  }
}
