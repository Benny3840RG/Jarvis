import type { ParsedInput } from "./conversationService.js";
import type { DomainRouter } from "./domainRouter.js";
import type { OrchestrationGraph, OrchestrationNode } from "./graph.js";
import type { InteractionRecord } from "./learningEngine.js";
import type { MemoryService } from "./memoryService.js";
import type { SafetyEnvelope, SafetyResult } from "./safetyEnvelope.js";
import type { ZState, ZStateReport } from "./zState.js";
import type { Payload } from "./types.js";

export interface ExecutionStep extends OrchestrationNode {
  payload: Payload;
}

export interface ExecutionPlan {
  steps: ExecutionStep[];
}

export interface OrchestrationResult {
  outputs: unknown[];
  safety: SafetyResult;
  zStateReport: ZStateReport;
}

export class Orchestrator {
  constructor(
    private readonly memory: MemoryService,
    private readonly router: DomainRouter,
    private readonly safetyEnvelope: SafetyEnvelope,
    private readonly graph: OrchestrationGraph,
    private readonly zState: ZState,
    private readonly getHistory: () => InteractionRecord[],
  ) {}

  plan(input: ParsedInput): ExecutionPlan {
    this.memory.write("lastIntent", input.intent);
    const steps: ExecutionStep[] = this.graph.getNodesForIntent(input.intent).map((node) => ({
      module: node.module,
      action: node.action,
      weight: node.weight,
      payload: input.entities,
    }));
    return { steps };
  }

  async execute(plan: ExecutionPlan): Promise<OrchestrationResult> {
    const outputs: unknown[] = [];
    for (const step of plan.steps) {
      outputs.push(await this.router.route(step.module, step.action, step.payload));
    }

    const first = plan.steps[0];
    const safety = this.safetyEnvelope.evaluate({
      domain: first?.module ?? "unknown",
      action: first?.action ?? "unknown",
      payload: first?.payload ?? {},
      outputs,
    });

    const zStateReport = this.zState.canActivate(
      first?.action ?? "unknown",
      plan.steps.map((step) => ({ module: step.module, action: step.action, weight: step.weight })),
      this.getHistory(),
    );

    return { outputs, safety, zStateReport };
  }
}
