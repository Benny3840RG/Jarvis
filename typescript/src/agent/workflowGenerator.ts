import type { OrchestrationNode } from "./graph.js";
import type { IntentStats } from "./learningEngine.js";

export interface WorkflowProposal {
  id: string;
  intent: string;
  nodes: OrchestrationNode[];
  confidence: number;
  notes?: string;
}

let proposalSequence = 0;

export class WorkflowGenerator {
  /**
   * Proposes a workflow for an intent. Confidence is derived from the intent's
   * observed success rate when stats are available, otherwise a neutral default.
   */
  propose(intent: string, nodes: OrchestrationNode[], stats: IntentStats = {}): WorkflowProposal {
    const intentStats = stats[intent];
    const confidence =
      intentStats && intentStats.total > 0 ? intentStats.success / intentStats.total : 0.5;

    return {
      id: `wf_${(proposalSequence += 1)}`,
      intent,
      nodes,
      confidence,
      notes:
        intentStats && intentStats.total > 0
          ? `Confidence from ${intentStats.success}/${intentStats.total} successful ${intent} interactions.`
          : "No observed history yet; using a neutral confidence.",
    };
  }
}
