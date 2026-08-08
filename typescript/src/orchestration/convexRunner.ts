import type { OrchestrationExecutor, OrchestrationOutcomeRecorder } from "./contracts.js";
import type { OrchestrationGraph } from "./graph.js";
import {
  ConvexOrchestrationStateBoundary,
  type ConvexOrchestrationBeginRunInput,
  type ConvexOrchestrationBeginRunResult,
} from "./convexStateBoundary.js";
import {
  OrchestrationRunner,
  type OrchestrationRunnerOptions,
  type OrchestrationRunResult,
  type OrchestrationSafetyGate,
} from "./runner.js";
import type { OrchestrationContext } from "./contracts.js";

export type ConvexOrchestrationRunResult =
  | { status: "created"; result: OrchestrationRunResult }
  | { status: "replayed" | "conflict"; run: Record<string, unknown> };

export function createConvexOrchestrationRunner(
  state: ConvexOrchestrationStateBoundary,
  executor: OrchestrationExecutor,
  safety: OrchestrationSafetyGate,
  outcomes: OrchestrationOutcomeRecorder,
  options: OrchestrationRunnerOptions = {},
): OrchestrationRunner {
  return new OrchestrationRunner(executor, safety, outcomes, {
    ...options,
    stepState: state,
  });
}

/**
 * Durable run coordinator. Replay and fingerprint conflict are handled before
 * any graph node can cross the executor boundary.
 */
export class ConvexOrchestrationRunner {
  constructor(
    private readonly state: ConvexOrchestrationStateBoundary,
    private readonly runner: OrchestrationRunner,
  ) {}

  async run(
    graph: OrchestrationGraph,
    context: OrchestrationContext,
    metadata: Omit<ConvexOrchestrationBeginRunInput, "context" | "graph">,
  ): Promise<ConvexOrchestrationRunResult> {
    const begun: ConvexOrchestrationBeginRunResult = await this.state.beginRun({
      context,
      graph,
      ...metadata,
    });
    if (begun.status !== "created") {
      return { status: begun.status, run: begun.run };
    }
    return { status: "created", result: await this.runner.run(graph, context) };
  }
}
