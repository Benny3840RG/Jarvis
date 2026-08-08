import { ConvexHttpClient } from "convex/browser";

import { api } from "../../convex/_generated/api.js";
import type { ConvexClientLike } from "../persistence/convexPersistence.js";
import type { DomainFailure, DomainSuccess, OrchestrationContext } from "./contracts.js";
import type { OrchestrationGraph } from "./graph.js";
import type { OrchestrationNode } from "./graph.js";
import type { OrchestrationStepLease, OrchestrationStepStateBoundary } from "./stateBoundary.js";

export const orchestrationStateFunctions = api.orchestrationState;

export type ConvexOrchestrationStateBoundaryOptions = {
  client?: ConvexClientLike;
  serviceToken?: string;
  workerId: string;
  leaseTtlMs: number;
};

export type ConvexOrchestrationBeginRunInput = {
  context: OrchestrationContext;
  graph: OrchestrationGraph;
  requestFingerprint: string;
  planFingerprint: string;
  policyVersion: string;
  policyFingerprint: string;
  maxRetries: number;
};

export type ConvexOrchestrationBeginRunResult = {
  status: "created" | "replayed" | "conflict";
  run: Record<string, unknown>;
};

function required(value: string, label: string): string {
  const normalized = value.trim();
  if (!normalized) throw new Error(`${label} is required.`);
  return normalized;
}

function safePositiveInteger(value: number, label: string): number {
  if (!Number.isSafeInteger(value) || value <= 0) {
    throw new Error(`${label} must be a positive safe integer.`);
  }
  return value;
}

/**
 * Client-side composition boundary for the maintained Convex orchestration
 * state machine. It intentionally does not start any trigger ingress.
 */
export class ConvexOrchestrationStateBoundary implements OrchestrationStepStateBoundary {
  private readonly client: ConvexClientLike;
  private readonly serviceToken: string;
  private readonly workerId: string;
  private readonly leaseTtlMs: number;

  constructor(options: ConvexOrchestrationStateBoundaryOptions) {
    this.serviceToken = required(
      options.serviceToken ?? process.env.JARVIS_SERVICE_TOKEN ?? "",
      "JARVIS_SERVICE_TOKEN",
    );
    this.workerId = required(options.workerId, "Orchestration worker ID");
    this.leaseTtlMs = safePositiveInteger(options.leaseTtlMs, "Orchestration leaseTtlMs");

    if (options.client) {
      this.client = options.client;
      return;
    }

    const convexUrl = process.env.CONVEX_URL;
    if (!convexUrl) throw new Error("Convex orchestration requires CONVEX_URL.");
    this.client = new ConvexHttpClient(convexUrl);
  }

  async beginRun(
    input: ConvexOrchestrationBeginRunInput,
  ): Promise<ConvexOrchestrationBeginRunResult> {
    const trigger = input.context.trigger;
    if (!trigger) {
      throw new Error("Convex orchestration runs require a validated trigger.");
    }

    const result = await this.client.mutation(orchestrationStateFunctions.beginRun, {
      serviceToken: this.serviceToken,
      runId: input.context.runId,
      triggerId: trigger.id,
      triggerSource: trigger.source,
      triggerKind: trigger.kind,
      idempotencyKey: trigger.idempotencyKey,
      requestFingerprint: required(input.requestFingerprint, "requestFingerprint"),
      planFingerprint: required(input.planFingerprint, "planFingerprint"),
      triggerPayload: { ...trigger.payload },
      authority: input.context.authority,
      policyVersion: required(input.policyVersion, "policyVersion"),
      policyFingerprint: required(input.policyFingerprint, "policyFingerprint"),
      nodeIds: input.graph.orderedNodes().map((node) => node.id),
      maxRetries: input.maxRetries,
    });
    return result as ConvexOrchestrationBeginRunResult;
  }

  async start(input: {
    context: OrchestrationContext;
    node: OrchestrationNode;
  }): Promise<OrchestrationStepLease> {
    const result = await this.client.mutation(orchestrationStateFunctions.markStepRunning, {
      serviceToken: this.serviceToken,
      runId: input.context.runId,
      nodeId: input.node.id,
      operationId: input.node.command.operationId,
      workerId: this.workerId,
      leaseTtlMs: this.leaseTtlMs,
    });
    return { leaseToken: (result as { leaseToken: string }).leaseToken };
  }

  async succeed(input: {
    context: OrchestrationContext;
    node: OrchestrationNode;
    leaseToken: string;
    result: DomainSuccess;
  }): Promise<void> {
    await this.client.mutation(orchestrationStateFunctions.recordStepSuccess, {
      serviceToken: this.serviceToken,
      runId: input.context.runId,
      nodeId: input.node.id,
      workerId: this.workerId,
      leaseToken: input.leaseToken,
    });
  }

  async fail(input: {
    context: OrchestrationContext;
    node: OrchestrationNode;
    leaseToken: string;
    failure: DomainFailure;
  }): Promise<void> {
    await this.client.mutation(orchestrationStateFunctions.recordStepFailure, {
      serviceToken: this.serviceToken,
      runId: input.context.runId,
      nodeId: input.node.id,
      workerId: this.workerId,
      leaseToken: input.leaseToken,
      failureCode: input.failure.code,
    });
  }
}
