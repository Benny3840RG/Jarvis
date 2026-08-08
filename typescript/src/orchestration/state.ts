npm warn Unknown env config "http-proxy". This will stop working in the next major version of npm.
import type { DomainFailureCode, OrchestrationCommand } from "./contracts.js";
import type { OrchestrationTriggerSource } from "./trigger.js";
import type { ToolAuthority } from "../runtime/totalityPolicy.js";

export const ORCHESTRATION_RUN_STATES = [
  "queued",
  "running",
  "succeeded",
  "failed",
  "indeterminate",
] as const;
export type OrchestrationRunState = (typeof ORCHESTRATION_RUN_STATES)[number];

export const ORCHESTRATION_STEP_STATES = [
  "pending",
  "running",
  "succeeded",
  "failed",
  "indeterminate",
] as const;
export type OrchestrationStepState = (typeof ORCHESTRATION_STEP_STATES)[number];

export type OrchestrationRunRecord = {
  readonly runId: string;
  readonly triggerId: string;
  readonly triggerSource: OrchestrationTriggerSource;
  readonly triggerKind: string;
  readonly idempotencyKey: string;
  readonly requestFingerprint: string;
  readonly authority: ToolAuthority;
  readonly nodeIds: readonly string[];
  readonly completedStepIds: readonly string[];
  readonly state: OrchestrationRunState;
  readonly failureCode?: DomainFailureCode;
  readonly createdAt: number;
  readonly updatedAt: number;
};

export type OrchestrationStepRecord = {
  readonly runId: string;
  readonly nodeId: string;
  readonly operationId?: OrchestrationCommand["operationId"];
  readonly state: OrchestrationStepState;
  readonly attempt: number;
  readonly outputDigest?: string;
  readonly failureCode?: DomainFailureCode;
  readonly updatedAt: number;
  readonly completedAt?: number;
};

export type BeginOrchestrationRunInput = {
  runId: string;
  triggerId: string;
  triggerSource: OrchestrationTriggerSource;
  triggerKind: string;
  idempotencyKey: string;
  requestFingerprint: string;
  authority: ToolAuthority;
  nodeIds: readonly string[];
  now: number;
};

export type BeginOrchestrationRunResult =
  | { status: "created"; run: OrchestrationRunRecord }
  | { status: "replayed"; run: OrchestrationRunRecord }
  | { status: "conflict"; run: OrchestrationRunRecord };

export type MarkStepRunningInput = {
  runId: string;
  nodeId: string;
  operationId: OrchestrationCommand["operationId"];
  now: number;
};

export type RecordStepSuccessInput = {
  runId: string;
  nodeId: string;
  now: number;
  outputDigest?: string;
};

export type RecordStepFailureInput = {
  runId: string;
  nodeId: string;
  now: number;
  failureCode: DomainFailureCode;
};

export type DurableOrchestrationStateStore = {
  beginRun(
    input: BeginOrchestrationRunInput,
  ): Promise<BeginOrchestrationRunResult>;
  getRun(runId: string): Promise<OrchestrationRunRecord | null>;
  listSteps(runId: string): Promise<readonly OrchestrationStepRecord[]>;
  markStepRunning(
    input: MarkStepRunningInput,
  ): Promise<OrchestrationStepRecord>;
  recordStepSuccess(
    input: RecordStepSuccessInput,
  ): Promise<OrchestrationStepRecord>;
  recordStepFailure(
    input: RecordStepFailureInput,
  ): Promise<OrchestrationStepRecord>;
  recordStepIndeterminate(
    input: RecordStepFailureInput,
  ): Promise<OrchestrationStepRecord>;
};

type MutableRun = {
  runId: string;
  triggerId: string;
  triggerSource: OrchestrationTriggerSource;
  triggerKind: string;
  idempotencyKey: string;
  requestFingerprint: string;
  authority: ToolAuthority;
  nodeIds: string[];
  completedStepIds: string[];
  state: OrchestrationRunState;
  failureCode?: DomainFailureCode;
  createdAt: number;
  updatedAt: number;
};

type MutableStep = {
  runId: string;
  nodeId: string;
  operationId?: OrchestrationCommand["operationId"];
  state: OrchestrationStepState;
  attempt: number;
  outputDigest?: string;
  failureCode?: DomainFailureCode;
  updatedAt: number;
  completedAt?: number;
};

function required(value: string, label: string): string {
  const normalized = value.trim();
  if (!normalized) throw new Error(`orchestration ${label} is required`);
  return normalized;
}

function validTimestamp(value: number): number {
  if (!Number.isFinite(value) || value < 0) {
    throw new Error(
      "orchestration timestamp must be a finite non-negative number",
    );
  }
  return value;
}

function freezeRun(run: MutableRun): OrchestrationRunRecord {
  return Object.freeze({
    ...run,
    nodeIds: Object.freeze([...run.nodeIds]),
    completedStepIds: Object.freeze([...run.completedStepIds]),
  });
}

function freezeStep(step: MutableStep): OrchestrationStepRecord {
  return Object.freeze({ ...step });
}

export class InMemoryOrchestrationStateStore implements DurableOrchestrationStateStore {
  private readonly runs = new Map<string, MutableRun>();
  private readonly runByIdempotencyKey = new Map<string, string>();
  private readonly steps = new Map<string, Map<string, MutableStep>>();

  async beginRun(
    input: BeginOrchestrationRunInput,
  ): Promise<BeginOrchestrationRunResult> {
    const runId = required(input.runId, "run ID");
    const triggerId = required(input.triggerId, "trigger ID");
    const triggerKind = required(input.triggerKind, "trigger kind");
    const idempotencyKey = required(input.idempotencyKey, "idempotency key");
    const requestFingerprint = required(
      input.requestFingerprint,
      "request fingerprint",
    );
    const nodeIds = input.nodeIds.map((nodeId) => required(nodeId, "node ID"));
    validTimestamp(input.now);

    if (new Set(nodeIds).size !== nodeIds.length) {
      throw new Error("duplicate orchestration node ID");
    }

    const idempotencyIndex = `${input.triggerSource}:${idempotencyKey}`;
    const existingRunId = this.runByIdempotencyKey.get(idempotencyIndex);
    if (existingRunId !== undefined) {
      const existing = this.requireRun(existingRunId);
      const sameRequest =
        existing.requestFingerprint === requestFingerprint &&
        existing.triggerKind === triggerKind &&
        existing.triggerSource === input.triggerSource;
      return {
        status: sameRequest ? "replayed" : "conflict",
        run: freezeRun(existing),
      };
    }

    if (this.runs.has(runId))
      throw new Error(`orchestration run already exists: ${runId}`);

    const run: MutableRun = {
      runId,
      triggerId,
      triggerSource: input.triggerSource,
      triggerKind,
      idempotencyKey,
      requestFingerprint,
      authority: input.authority,
      nodeIds: [...nodeIds],
      completedStepIds: [],
      state: "queued",
      createdAt: input.now,
      updatedAt: input.now,
    };
    const stepMap = new Map<string, MutableStep>();
    for (const nodeId of nodeIds) {
      stepMap.set(nodeId, {
        runId,
        nodeId,
        state: "pending",
        attempt: 0,
        updatedAt: input.now,
      });
    }
    this.runs.set(runId, run);
    this.runByIdempotencyKey.set(idempotencyIndex, runId);
    this.steps.set(runId, stepMap);
    return { status: "created", run: freezeRun(run) };
  }

  async getRun(runId: string): Promise<OrchestrationRunRecord | null> {
    const run = this.runs.get(required(runId, "run ID"));
    return run === undefined ? null : freezeRun(run);
  }

  async listSteps(runId: string): Promise<readonly OrchestrationStepRecord[]> {
    const steps = this.steps.get(required(runId, "run ID"));
    if (steps === undefined)
      throw new Error(`orchestration run not found: ${runId}`);
    return Object.freeze([...steps.values()].map(freezeStep));
  }

  async markStepRunning(
    input: MarkStepRunningInput,
  ): Promise<OrchestrationStepRecord> {
    const run = this.requireRun(input.runId);
    const step = this.requireStep(input.runId, input.nodeId);
    validTimestamp(input.now);
    if (step.state !== "pending") {
      throw new Error(`cannot transition step ${step.state} to running`);
    }
    if (run.state !== "queued" && run.state !== "running") {
      throw new Error(`cannot start step for run ${run.state}`);
    }

    step.operationId = input.operationId;
    step.state = "running";
    step.attempt += 1;
    step.updatedAt = input.now;
    if (run.state === "queued") run.state = "running";
    run.updatedAt = input.now;
    return freezeStep(step);
  }

  async recordStepSuccess(
    input: RecordStepSuccessInput,
  ): Promise<OrchestrationStepRecord> {
    const run = this.requireRun(input.runId);
    const step = this.requireStep(input.runId, input.nodeId);
    validTimestamp(input.now);
    this.requireRunningStep(step);
    if (run.state !== "running")
      throw new Error(`cannot complete step for run ${run.state}`);

    step.state = "succeeded";
    if (input.outputDigest !== undefined)
      step.outputDigest = required(input.outputDigest, "output digest");
    step.updatedAt = input.now;
    step.completedAt = input.now;
    if (!run.completedStepIds.includes(step.nodeId))
      run.completedStepIds.push(step.nodeId);
    if (run.completedStepIds.length === run.nodeIds.length)
      run.state = "succeeded";
    run.updatedAt = input.now;
    return freezeStep(step);
  }

  async recordStepFailure(
    input: RecordStepFailureInput,
  ): Promise<OrchestrationStepRecord> {
    return this.recordTerminalStep(input, "failed");
  }

  async recordStepIndeterminate(
    input: RecordStepFailureInput,
  ): Promise<OrchestrationStepRecord> {
    return this.recordTerminalStep(input, "indeterminate");
  }

  private async recordTerminalStep(
    input: RecordStepFailureInput,
    state: "failed" | "indeterminate",
  ): Promise<OrchestrationStepRecord> {
    const run = this.requireRun(input.runId);
    const step = this.requireStep(input.runId, input.nodeId);
    validTimestamp(input.now);
    this.requireRunningStep(step);
    if (run.state !== "running")
      throw new Error(`cannot stop step for run ${run.state}`);

    step.state = state;
    step.failureCode = input.failureCode;
    step.updatedAt = input.now;
    step.completedAt = input.now;
    run.state = state;
    run.failureCode = input.failureCode;
    run.updatedAt = input.now;
    return freezeStep(step);
  }

  private requireRun(runId: string): MutableRun {
    const normalized = required(runId, "run ID");
    const run = this.runs.get(normalized);
    if (run === undefined)
      throw new Error(`orchestration run not found: ${normalized}`);
    return run;
  }

  private requireStep(runId: string, nodeId: string): MutableStep {
    const normalizedRunId = required(runId, "run ID");
    const normalizedNodeId = required(nodeId, "node ID");
    const step = this.steps.get(normalizedRunId)?.get(normalizedNodeId);
    if (step === undefined) {
      throw new Error(
        `orchestration step not found: ${normalizedRunId}/${normalizedNodeId}`,
      );
    }
    return step;
  }

  private requireRunningStep(step: MutableStep): void {
    if (step.state !== "running") {
      throw new Error(`cannot transition step ${step.state} to terminal state`);
    }
  }
}
npm notice
npm notice New minor version of npm available! 11.9.0 -> 11.19.0
npm notice Changelog: https://github.com/npm/cli/releases/tag/v11.19.0
npm notice To update run: npm install -g npm@11.19.0
npm notice
