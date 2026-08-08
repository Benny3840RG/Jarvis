import { IMPLEMENTED_CAPABILITIES, type Capability } from "../http/contracts.js";
import type {
  DomainFailure,
  DomainResult,
  DomainSuccess,
  OrchestrationContext,
  OrchestrationExecutor,
  OrchestrationOutcomeRecorder,
  OrchestrationValue,
} from "./contracts.js";
import type { OrchestrationGraph, OrchestrationNode } from "./graph.js";
import type { OrchestrationStepStateBoundary } from "./stateBoundary.js";

export type SafetyDecision =
  { status: "ok"; reasons: readonly [] } | { status: "blocked"; reasons: readonly string[] };

export type CompletedStep = {
  nodeId: string;
  operationId: OrchestrationNode["command"]["operationId"];
  result: DomainSuccess;
};

export interface OrchestrationSafetyGate {
  preflight(input: {
    context: OrchestrationContext;
    node: OrchestrationNode;
    capability: Capability;
    completedSteps: readonly CompletedStep[];
  }): Promise<SafetyDecision>;

  postflight(input: {
    context: OrchestrationContext;
    node: OrchestrationNode;
    capability: Capability;
    result: DomainSuccess;
    completedSteps: readonly CompletedStep[];
  }): Promise<SafetyDecision>;
}

export type OrchestrationRunResult =
  | {
      ok: true;
      runId: string;
      completedSteps: readonly CompletedStep[];
    }
  | {
      ok: false;
      runId: string;
      completedSteps: readonly CompletedStep[];
      failedNodeId: string;
      failure: DomainFailure;
      executedResult?: DomainSuccess;
    };

function capabilityFor(node: OrchestrationNode): Capability | null {
  return (
    IMPLEMENTED_CAPABILITIES.find(
      (capability) => capability.operationId === node.command.operationId,
    ) ?? null
  );
}

function failure(code: DomainFailure["code"], message: string, retryable = false): DomainFailure {
  return { ok: false, code, message, retryable };
}

function decisionMessage(prefix: string, reasons: readonly string[]): string {
  const detail = reasons.filter((reason) => reason.trim().length > 0).join("; ");
  return detail.length === 0 ? prefix : `${prefix}: ${detail}`;
}

export type OrchestrationRunnerOptions = {
  /** Maximum number of nodes allowed to cross the execution boundary. */
  maxSteps?: number;
  /** Maximum wall-clock duration for one run. */
  maxDurationMs?: number;
  /** Injectable clock for deterministic deadline verification. */
  clock?: () => number;
  /** Durable step lifecycle; omitted for pure/unit execution. */
  stepState?: OrchestrationStepStateBoundary;
};

const DEFAULT_MAX_STEPS = 100;
const DEFAULT_MAX_DURATION_MS = 60_000;

function positiveSafeInteger(value: number): boolean {
  return Number.isSafeInteger(value) && value > 0;
}

export class OrchestrationRunner {
  private readonly maxSteps: number;
  private readonly maxDurationMs: number;
  private readonly clock: () => number;
  private readonly stepState?: OrchestrationStepStateBoundary;

  constructor(
    private readonly executor: OrchestrationExecutor,
    private readonly safety: OrchestrationSafetyGate,
    private readonly outcomes: OrchestrationOutcomeRecorder,
    options: OrchestrationRunnerOptions = {},
  ) {
    this.maxSteps = options.maxSteps ?? DEFAULT_MAX_STEPS;
    this.maxDurationMs = options.maxDurationMs ?? DEFAULT_MAX_DURATION_MS;
    this.clock = options.clock ?? Date.now;
    this.stepState = options.stepState;
    if (!positiveSafeInteger(this.maxSteps)) {
      throw new Error("Orchestration maxSteps must be a positive safe integer.");
    }
    if (!positiveSafeInteger(this.maxDurationMs)) {
      throw new Error("Orchestration maxDurationMs must be a positive safe integer.");
    }
  }

  async run(
    graph: OrchestrationGraph,
    context: OrchestrationContext,
  ): Promise<OrchestrationRunResult> {
    const completedSteps: CompletedStep[] = [];
    const startedAt = this.clock();
    const nodes = graph.orderedNodes();

    for (let index = 0; index < nodes.length; index += 1) {
      const node = nodes[index];
      if (index >= this.maxSteps || this.clock() - startedAt >= this.maxDurationMs) {
        return this.stop(
          context,
          node,
          completedSteps,
          failure("execution_budget_exceeded", "Orchestration execution budget exhausted."),
        );
      }
      const capability = capabilityFor(node);
      let leaseToken: string | undefined;
      if (!capability) {
        return this.stop(
          context,
          node,
          completedSteps,
          failure(
            "blocked",
            `Operation ${node.command.operationId} is not present in the implemented capability contract.`,
          ),
        );
      }

      if (this.stepState) {
        try {
          leaseToken = (await this.stepState.start({ context, node })).leaseToken;
        } catch (error: unknown) {
          return this.stop(
            context,
            node,
            completedSteps,
            failure(
              "dependency_failure",
              `Durable step lease could not be acquired: ${error instanceof Error ? error.message : String(error)}`,
              true,
            ),
            undefined,
            true,
          );
        }
      }

      let preflight: SafetyDecision;
      try {
        preflight = await this.safety.preflight({
          context,
          node,
          capability,
          completedSteps,
        });
      } catch (error: unknown) {
        return this.stop(
          context,
          node,
          completedSteps,
          failure(
            "dependency_failure",
            `Preflight safety evaluation failed: ${error instanceof Error ? error.message : String(error)}`,
            true,
          ),
          undefined,
          false,
          leaseToken,
        );
      }

      if (preflight.status === "blocked") {
        return this.stop(
          context,
          node,
          completedSteps,
          failure(
            "blocked",
            decisionMessage("Preflight safety blocked execution", preflight.reasons),
          ),
          undefined,
          false,
          leaseToken,
        );
      }

      let result: DomainResult<OrchestrationValue>;
      try {
        result = await this.executor.execute(node.command, context);
      } catch (error: unknown) {
        result = failure(
          "dependency_failure",
          `Operation execution failed: ${error instanceof Error ? error.message : String(error)}`,
          true,
        );
      }

      if (!result.ok)
        return this.stop(context, node, completedSteps, result, undefined, false, leaseToken);

      let postflight: SafetyDecision;
      try {
        postflight = await this.safety.postflight({
          context,
          node,
          capability,
          result,
          completedSteps,
        });
      } catch (error: unknown) {
        return this.stop(
          context,
          node,
          completedSteps,
          failure(
            "dependency_failure",
            `Postflight safety evaluation failed: ${error instanceof Error ? error.message : String(error)}`,
            true,
          ),
          undefined,
          false,
          leaseToken,
        );
      }

      if (postflight.status === "blocked") {
        return this.stop(
          context,
          node,
          completedSteps,
          failure(
            "postcondition_failed",
            decisionMessage("Postflight consistency verification failed", postflight.reasons),
          ),
          result,
          false,
          leaseToken,
        );
      }

      try {
        await this.outcomes.record({
          runId: context.runId,
          nodeId: node.id,
          operationId: node.command.operationId,
          success: true,
        });
      } catch (error: unknown) {
        return {
          ok: false,
          runId: context.runId,
          completedSteps,
          failedNodeId: node.id,
          failure: failure(
            "audit_failure",
            `Successful operation could not be recorded: ${error instanceof Error ? error.message : String(error)}`,
            true,
          ),
          executedResult: result,
        };
      }

      if (this.stepState) {
        if (!leaseToken) {
          return {
            ok: false,
            runId: context.runId,
            completedSteps,
            failedNodeId: node.id,
            failure: failure("audit_failure", "Durable step success had no active lease.", true),
            executedResult: result,
          };
        }
        try {
          await this.stepState.succeed({ context, node, leaseToken, result });
        } catch (error: unknown) {
          return {
            ok: false,
            runId: context.runId,
            completedSteps,
            failedNodeId: node.id,
            failure: failure(
              "audit_failure",
              `Successful operation could not be committed to durable state: ${error instanceof Error ? error.message : String(error)}`,
              true,
            ),
            executedResult: result,
          };
        }
      }

      completedSteps.push({
        nodeId: node.id,
        operationId: node.command.operationId,
        result,
      });
    }

    return { ok: true, runId: context.runId, completedSteps };
  }

  private async stop(
    context: OrchestrationContext,
    node: OrchestrationNode,
    completedSteps: readonly CompletedStep[],
    stoppedBy: DomainFailure,
    executedResult?: DomainSuccess,
    stateUnavailable = false,
    leaseToken?: string,
  ): Promise<OrchestrationRunResult> {
    try {
      await this.outcomes.record({
        runId: context.runId,
        nodeId: node.id,
        operationId: node.command.operationId,
        success: false,
        failureCode: stoppedBy.code,
      });
    } catch (error: unknown) {
      return {
        ok: false,
        runId: context.runId,
        completedSteps,
        failedNodeId: node.id,
        failure: failure(
          "audit_failure",
          `Failure outcome could not be recorded after ${stoppedBy.code}: ${error instanceof Error ? error.message : String(error)}`,
          true,
        ),
        ...(executedResult === undefined ? {} : { executedResult }),
      };
    }

    if (this.stepState && !stateUnavailable && leaseToken !== undefined) {
      try {
        const activeLeaseToken = leaseToken;
        await this.stepState.fail({
          context,
          node,
          leaseToken: activeLeaseToken,
          failure: stoppedBy,
        });
      } catch (error: unknown) {
        return {
          ok: false,
          runId: context.runId,
          completedSteps,
          failedNodeId: node.id,
          failure: failure(
            "audit_failure",
            `Failure outcome could not be committed to durable state after ${stoppedBy.code}: ${error instanceof Error ? error.message : String(error)}`,
            true,
          ),
          ...(executedResult === undefined ? {} : { executedResult }),
        };
      }
    }

    return {
      ok: false,
      runId: context.runId,
      completedSteps,
      failedNodeId: node.id,
      failure: stoppedBy,
      ...(executedResult === undefined ? {} : { executedResult }),
    };
  }
}
