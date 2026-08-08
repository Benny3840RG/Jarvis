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

export interface ExecutionTrigger {
  source: "conversation";
  raw: string;
  intent: string;
}

export interface ExecutionPolicy {
  /** Maximum number of workflow steps that may cross the execution boundary. */
  maxSteps: number;
  /** Number of failed steps tolerated before execution halts. */
  maxFailures: number;
}

export interface ExecutionBudget {
  requestedSteps: number;
  maxSteps: number;
  truncated: boolean;
}

export interface ExecutionPlan {
  trigger: ExecutionTrigger;
  steps: ExecutionStep[];
  budget?: ExecutionBudget;
}

export interface ExecutionRecovery {
  status: "completed" | "halted";
  attemptedSteps: number;
  failedSteps: number;
  reason?: "step-budget-exhausted" | "failure-budget-exhausted";
  haltedStep?: Pick<ExecutionStep, "module" | "action">;
}

export interface OrchestrationResult {
  outputs: unknown[];
  safety: SafetyResult;
  zStateReport: ZStateReport;
  recovery: ExecutionRecovery;
}

export interface OrchestratorOptions {
  execution?: Partial<ExecutionPolicy>;
}

const DEFAULT_EXECUTION_POLICY: ExecutionPolicy = {
  maxSteps: 10,
  maxFailures: 0,
};

function isPositiveSafeInteger(value: number): boolean {
  return Number.isSafeInteger(value) && value > 0;
}

function normalisePolicy(options: OrchestratorOptions): ExecutionPolicy {
  const policy = { ...DEFAULT_EXECUTION_POLICY, ...options.execution };
  if (!isPositiveSafeInteger(policy.maxSteps)) {
    throw new Error("Execution maxSteps must be a positive safe integer.");
  }
  if (!Number.isSafeInteger(policy.maxFailures) || policy.maxFailures < 0) {
    throw new Error("Execution maxFailures must be a non-negative safe integer.");
  }
  return policy;
}

function isErrorOutput(value: unknown): boolean {
  return (
    typeof value === "object" &&
    value !== null &&
    "error" in value &&
    typeof (value as { error: unknown }).error === "string"
  );
}

export class Orchestrator {
  private readonly executionPolicy: ExecutionPolicy;

  constructor(
    private readonly memory: MemoryService,
    private readonly router: DomainRouter,
    private readonly safetyEnvelope: SafetyEnvelope,
    private readonly graph: OrchestrationGraph,
    private readonly zState: ZState,
    private readonly getHistory: () => InteractionRecord[],
    options: OrchestratorOptions = {},
  ) {
    this.executionPolicy = normalisePolicy(options);
  }

  plan(input: ParsedInput): ExecutionPlan {
    this.memory.write("lastIntent", input.intent);

    const nodes = [...this.graph.getNodesForIntent(input.intent)].sort(
      (left, right) => (right.weight ?? 0) - (left.weight ?? 0),
    );
    const boundedNodes = nodes.slice(0, this.executionPolicy.maxSteps);

    return {
      trigger: {
        source: "conversation",
        raw: input.raw,
        intent: input.intent,
      },
      steps: boundedNodes.map((node) => ({
        module: node.module,
        action: node.action,
        weight: node.weight,
        payload: input.entities,
      })),
      budget: {
        requestedSteps: nodes.length,
        maxSteps: this.executionPolicy.maxSteps,
        truncated: nodes.length > this.executionPolicy.maxSteps,
      },
    };
  }

  async execute(plan: ExecutionPlan): Promise<OrchestrationResult> {
    const outputs: unknown[] = [];
    const steps = plan.steps.slice(0, this.executionPolicy.maxSteps);
    const budgetExhausted =
      plan.budget?.truncated === true || plan.steps.length > this.executionPolicy.maxSteps;
    let failedSteps = 0;
    let haltedStep: Pick<ExecutionStep, "module" | "action"> | undefined;
    let reason: ExecutionRecovery["reason"];

    for (const step of steps) {
      try {
        const output = await this.router.route(step.module, step.action, step.payload);
        outputs.push(output);

        if (isErrorOutput(output)) {
          failedSteps += 1;
          if (failedSteps > this.executionPolicy.maxFailures) {
            haltedStep = { module: step.module, action: step.action };
            reason = "failure-budget-exhausted";
            break;
          }
        }
      } catch {
        failedSteps += 1;
        outputs.push({
          errorCode: "execution-failed",
          module: step.module,
          action: step.action,
        });
        if (failedSteps > this.executionPolicy.maxFailures) {
          haltedStep = { module: step.module, action: step.action };
          reason = "failure-budget-exhausted";
          break;
        }
      }
    }

    if (reason === undefined && budgetExhausted) reason = "step-budget-exhausted";

    const first = steps[0];
    const safety = this.safetyEnvelope.evaluate({
      domain: first?.module ?? "unknown",
      action: first?.action ?? "unknown",
      payload: first?.payload ?? {},
      outputs,
    });

    const zStateReport = this.zState.canActivate(
      first?.action ?? "unknown",
      steps.map((step) => ({ module: step.module, action: step.action, weight: step.weight })),
      this.getHistory(),
    );

    return {
      outputs,
      safety,
      zStateReport,
      recovery: {
        status: reason === undefined ? "completed" : "halted",
        attemptedSteps: outputs.length,
        failedSteps,
        ...(reason === undefined ? {} : { reason }),
        ...(haltedStep === undefined ? {} : { haltedStep }),
      },
    };
  }
}
