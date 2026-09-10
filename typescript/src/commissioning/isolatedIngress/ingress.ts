import { randomUUID } from "node:crypto";

import { getAuthenticatedPrincipal } from "../../http/authenticatedPrincipal.js";
import type { ConvexClientLike } from "../../persistence/convexPersistence.js";
import type {
  CommissioningProbeValue,
  OrchestrationExecutor,
} from "../../orchestration/contracts.js";
import {
  authenticatedWorkerId,
  createConvexOrchestrationStateBoundaryForAuthenticatedRequest,
} from "../../orchestration/convexStateBoundary.js";
import { ConvexOrchestrationRunner } from "../../orchestration/convexRunner.js";
import { orchestrationRequestFingerprint } from "../../orchestration/fingerprints.js";
import { OrchestrationGraph } from "../../orchestration/graph.js";
import {
  CommissioningEvidenceLog,
  type CommissioningDeliveryClassification,
  type CommissioningDisposition,
} from "./evidence.js";
import {
  COMMISSIONING_LEASE_TTL_MS,
  COMMISSIONING_MAX_RETRIES,
  COMMISSIONING_POLICY_VERSION,
  COMMISSIONING_PROBE_OPERATION_ID,
  COMMISSIONING_TRIGGER_KIND,
  COMMISSIONING_TRIGGER_SOURCE,
  commissioningAuthority,
  commissioningPolicyFingerprint,
  commissioningProbeCapability,
} from "./policy.js";
import { createCommissioningProbeExecutor } from "./probeExecutor.js";
import { createCommissioningSafetyGate } from "./safetyGate.js";
import type { CommissioningIngressBody } from "./requestSchema.js";

const DEFAULT_ADMISSION_TIMEOUT_MS = 10_000;
const TERMINAL_RUN_STATES = new Set(["succeeded", "failed", "indeterminate"]);

export type CommissioningIngressDeps = {
  campaignId: string;
  evidence: CommissioningEvidenceLog;
  serviceToken?: string;
  client?: ConvexClientLike;
  now?: () => number;
  leaseTtlMs?: number;
  maxRetries?: number;
  admissionTimeoutMs?: number;
  /**
   * Overrides the read-only probe executor. The default constructs nothing; the
   * only reason to override is a commissioning drill that needs to hold the
   * executor open (a barrier) to inspect the durable lease owner before
   * completion clears it.
   */
  probeExecutor?: OrchestrationExecutor;
};

export type CommissioningIngressOutcome = {
  disposition: CommissioningDisposition;
  status: number;
  detail: string;
  runId?: string;
  run?: Record<string, unknown>;
  probe?: CommissioningProbeValue;
};

export class CommissioningPrincipalError extends Error {}

class AdmissionTimeoutError extends Error {}

async function withAdmissionTimeout<T>(
  work: Promise<T>,
  timeoutMs: number,
  abort: AbortController,
): Promise<T> {
  let timer: NodeJS.Timeout | undefined;
  try {
    return await Promise.race([
      work,
      new Promise<never>((_resolve, reject) => {
        timer = setTimeout(() => {
          abort.abort();
          reject(new AdmissionTimeoutError("admission outcome unknown (timeout)"));
        }, timeoutMs);
      }),
    ]);
  } finally {
    if (timer) clearTimeout(timer);
  }
}

function readString(record: Record<string, unknown>, key: string): string | undefined {
  const value = record[key];
  return typeof value === "string" ? value : undefined;
}

/**
 * The isolated-ingress commissioning admission path (issue #324).
 *
 * One authenticated delivery → one canonical request fingerprint → policy-derived
 * authority → a one-node read-only `commissioningProbe` graph →
 * `ConvexOrchestrationRunner.run`. Admission (`beginRun`) is the only gate: a
 * replay or a fingerprint conflict never reaches the executor, a transport
 * failure or a timeout is an *unknown* outcome (no fresh key). Late admission
 * cannot start execution; already-started work may finish. Admitted deliveries
 * are recorded in bounded evidence so the drill can
 * reconcile each logical delivery to one canonical run.
 */
export class CommissioningIngressRunner {
  constructor(private readonly deps: CommissioningIngressDeps) {}

  async admit(
    request: object,
    body: CommissioningIngressBody,
    idempotencyKey: string,
    classification: CommissioningDeliveryClassification,
  ): Promise<CommissioningIngressOutcome> {
    const principal = getAuthenticatedPrincipal(request);
    if (principal === undefined) {
      throw new CommissioningPrincipalError("A verified authenticated principal is required.");
    }
    this.deps.evidence.reserveDelivery();
    const workerId = authenticatedWorkerId(principal);
    const now = this.deps.now ?? (() => Date.now());

    const { fingerprint, preImage } = orchestrationRequestFingerprint(body);
    const runId = randomUUID();
    const graph = new OrchestrationGraph([
      {
        id: "probe",
        command: { operationId: COMMISSIONING_PROBE_OPERATION_ID, input: { nonce: body.nonce } },
      },
    ]);
    const context = {
      runId,
      authority: commissioningAuthority(),
      trigger: {
        id: randomUUID(),
        kind: COMMISSIONING_TRIGGER_KIND,
        source: COMMISSIONING_TRIGGER_SOURCE,
        idempotencyKey,
        occurredAt: now(),
        payload: { campaignId: this.deps.campaignId },
      },
    };

    const boundary = createConvexOrchestrationStateBoundaryForAuthenticatedRequest(request, {
      ...(this.deps.client === undefined ? {} : { client: this.deps.client }),
      ...(this.deps.serviceToken === undefined ? {} : { serviceToken: this.deps.serviceToken }),
      leaseTtlMs: this.deps.leaseTtlMs ?? COMMISSIONING_LEASE_TTL_MS,
    });
    const runner = new ConvexOrchestrationRunner(
      boundary,
      this.deps.probeExecutor ?? createCommissioningProbeExecutor(this.deps.now),
      createCommissioningSafetyGate(),
      this.deps.evidence.asOutcomeRecorder(),
      {
        policyVersion: COMMISSIONING_POLICY_VERSION,
        policyFingerprint: commissioningPolicyFingerprint(),
      },
      { additionalCapabilities: [commissioningProbeCapability()] },
    );

    const outcome = await this.execute(runner, graph, context, runId, fingerprint);

    this.deps.evidence.recordDelivery({
      campaignId: this.deps.campaignId,
      idempotencyKey,
      requestFingerprint: fingerprint,
      preImage,
      workerId,
      classification,
      transient: outcome.disposition === "admission-unknown",
      disposition: outcome.disposition,
      ...(outcome.runId === undefined ? {} : { canonicalRunId: outcome.runId }),
      ...(outcome.detail === "" ? {} : { detail: outcome.detail }),
    });

    return outcome;
  }

  private async execute(
    runner: ConvexOrchestrationRunner,
    graph: OrchestrationGraph,
    context: Parameters<ConvexOrchestrationRunner["run"]>[1],
    runId: string,
    requestFingerprint: string,
  ): Promise<CommissioningIngressOutcome> {
    let result: Awaited<ReturnType<ConvexOrchestrationRunner["run"]>>;
    const abort = new AbortController();
    try {
      result = await withAdmissionTimeout(
        runner.run(
          graph,
          context,
          {
            requestFingerprint,
            maxRetries: this.deps.maxRetries ?? COMMISSIONING_MAX_RETRIES,
          },
          { signal: abort.signal },
        ),
        this.deps.admissionTimeoutMs ?? DEFAULT_ADMISSION_TIMEOUT_MS,
        abort,
      );
    } catch (error: unknown) {
      if (error instanceof AdmissionTimeoutError) {
        return {
          disposition: "admission-unknown",
          status: 503,
          detail:
            "The admission or execution outcome is unknown (timeout); work already started may still finish. Retry with the same Idempotency-Key.",
        };
      }
      return {
        disposition: "admission-unknown",
        status: 503,
        detail:
          "The admission or execution outcome is unknown; durable state could not be confirmed. Retry with the same Idempotency-Key.",
      };
    }

    if (result.status !== "created") {
      const run = result.run;
      const canonicalRunId = readString(run, "runId") ?? runId;
      if (result.status === "conflict") {
        return {
          disposition: "conflict",
          status: 409,
          detail: "The Idempotency-Key was already used for a semantically different request.",
          runId: canonicalRunId,
          run,
        };
      }
      const state = readString(run, "state");
      const terminal = state !== undefined && TERMINAL_RUN_STATES.has(state);
      return {
        disposition: terminal ? "terminal-replay" : "nonterminal-replay",
        status: terminal ? 200 : 202,
        detail: terminal
          ? "The canonical run for this key has already reached a terminal state."
          : "The canonical run for this key is still in progress; it was not re-executed.",
        runId: canonicalRunId,
        run,
      };
    }

    const runResult = result.result;
    if (runResult.ok) {
      const probeStep = runResult.completedSteps[0]?.result.value;
      const probe =
        probeStep && typeof probeStep === "object" && "probe" in probeStep
          ? (probeStep as CommissioningProbeValue)
          : undefined;
      return {
        disposition: "created-complete",
        status: 201,
        detail: "A new canonical run was created and the read-only probe completed.",
        runId: runResult.runId,
        ...(probe === undefined ? {} : { probe }),
      };
    }
    if (runResult.failure.code === "audit_failure") {
      return {
        disposition: "admission-unknown",
        status: 503,
        runId: runResult.runId,
        detail:
          "The execution or durable completion outcome is unknown. Reconcile using the same Idempotency-Key.",
      };
    }
    return {
      disposition: "created-failed",
      status: 500,
      detail: `The canonical run was created but the probe step failed: ${runResult.failure.message}`,
      runId: runResult.runId,
    };
  }
}
