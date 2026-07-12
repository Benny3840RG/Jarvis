import type { ParsedConversation } from "./conversationService.js";
import type { MemoryService } from "./memoryService.js";
import type { SafetyEnvelope } from "../safety/safetyEnvelope.js";

export type PlanStep = { module: string; action: string; payload: unknown };
export type ExecutionPlan = { steps: PlanStep[] };

export interface DomainRouter {
  route(module: string, action: string, payload: unknown): Promise<unknown>;
}

export class Orchestrator {
  constructor(
    private readonly memory: MemoryService,
    private readonly router: DomainRouter,
    private readonly safety: SafetyEnvelope,
  ) {}

  plan(input: ParsedConversation): ExecutionPlan {
    void this.memory;
    if (input.intent === "planning") {
      return { steps: [{ module: "domains", action: "plan", payload: input.text }] };
    }
    if (input.intent === "memory") {
      return { steps: [{ module: "memory", action: "recall", payload: input.text }] };
    }
    return { steps: [{ module: "runtime", action: "respond", payload: input.text }] };
  }

  async execute(plan: ExecutionPlan): Promise<{ outputs: unknown[]; safetyStatus: string }> {
    const outputs: unknown[] = [];
    for (const step of plan.steps) {
      outputs.push(await this.router.route(step.module, step.action, step.payload));
    }
    const safetyResult = this.safety.evaluate(outputs);
    return { outputs, safetyStatus: safetyResult.status };
  }
}
