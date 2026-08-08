import type { OrchestrationExecutor, OrchestrationOutcomeRecorder } from "./contracts.js";
import { orchestrationPlanFingerprint } from "./fingerprints.js";
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

export type ConvexOrchestrationCompositionAuthority = {
  policyVersion: string;
  policyFingerprint: string;
};

export type ConvexOrchestrationRunMetadata = Omit<
  ConvexOrchestrationBeginRunInput,
  "context" | "graph" | "planFingerprint" | "policyVersion" | "policyFingerprint"
>;

export type ConvexOrchestrationRunResult =
  | { status: "created"; result: OrchestrationRunResult }
  | { status: "replayed" | "conflict"; run: Record<string, unknown> };

function required(value: string, label: string): string {
  const normalized = value.trim();
  if (!normalized) throw new Error(`${label} is required.`);
  return normalized;
}

export function createConvexOrchestrationRunner(
  state: ConvexOrchestrationStateBoundary,
  executor: OrchestrationExecutor,
  safety: OrchestrationSafetyGate,
  outcomes: OrchestrationOutcomeRecorder,
  authority: ConvexOrchestrationCompositionAuthority,
  options: OrchestrationRunnerOptions = {},
): OrchestrationRunner {
  required(authority.policyVersion, "Orchestration policy version");
  required(authority.policyFingerprint, "Orchestration policy fingerprint");
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
  private readonly runner: OrchestrationRunner;
  private readonly authority: ConvexOrchestrationCompositionAuthority;

  constructor(
    private readonly state: ConvexOrchestrationStateBoundary,
    executor: OrchestrationExecutor,
    safety: OrchestrationSafetyGate,
    outcomes: OrchestrationOutcomeRecorder,
    authority: ConvexOrchestrationCompositionAuthority,
    options: OrchestrationRunnerOptions = {},
  ) {
    this.authority = {
      policyVersion: required(authority.policyVersion, "Orchestration policy version"),
      policyFingerprint: required(authority.policyFingerprint, "Orchestration policy fingerprint"),
    };
    this.runner = createConvexOrchestrationRunner(
      state,
      executor,
      safety,
      outcomes,
      this.authority,
      options,
    );
  }

  async run(
    graph: OrchestrationGraph,
    context: OrchestrationContext,
    metadata: ConvexOrchestrationRunMetadata,
  ): Promise<ConvexOrchestrationRunResult> {
    const begun: ConvexOrchestrationBeginRunResult = await this.state.beginRun({
      ...metadata,
      context,
      graph,
      planFingerprint: orchestrationPlanFingerprint(graph),
      policyVersion: this.authority.policyVersion,
      policyFingerprint: this.authority.policyFingerprint,
    });
    if (begun.status !== "created") {
      return { status: begun.status, run: begun.run };
    }
    return { status: "created", result: await this.runner.run(graph, context) };
  }
}
