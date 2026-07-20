import type { IntentStats } from "./learningEngine.js";

export interface RuleChange {
  ruleId: string;
  change: "increase_weight" | "decrease_weight";
  reason: string;
}

export class RuleEvolution {
  constructor(private readonly minObservations = 5) {}

  /**
   * Proposes graph-weight changes for an intent once enough interactions exist.
   * Proposals are advisory only; nothing is applied here.
   */
  proposeRuleChanges(intent: string, stats: IntentStats): RuleChange[] {
    const intentStats = stats[intent];
    if (!intentStats || intentStats.total < this.minObservations) return [];

    const successRate = intentStats.success / intentStats.total;
    if (successRate < 0.5) {
      return [
        {
          ruleId: `graph_weight_${intent}`,
          change: "decrease_weight",
          reason: `Low success rate (${successRate.toFixed(2)}) for intent ${intent}`,
        },
      ];
    }

    return [
      {
        ruleId: `graph_weight_${intent}`,
        change: "increase_weight",
        reason: `High success rate (${successRate.toFixed(2)}) for intent ${intent}`,
      },
    ];
  }
}
