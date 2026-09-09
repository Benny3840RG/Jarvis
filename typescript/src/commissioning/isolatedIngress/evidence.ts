import type {
  OrchestrationOutcome,
  OrchestrationOutcomeRecorder,
} from "../../orchestration/contracts.js";

export type CommissioningDeliveryClassification = "first-attempt" | "retry";

export type CommissioningDisposition =
  | "created-complete"
  | "created-failed"
  | "terminal-replay"
  | "nonterminal-replay"
  | "conflict"
  | "admission-unknown";

export type CommissioningEvidenceEntry =
  | {
      kind: "step-outcome";
      at: number;
      runId: string;
      nodeId: string;
      operationId: string;
      success: boolean;
      failureCode?: string;
    }
  | {
      kind: "delivery";
      at: number;
      campaignId: string;
      idempotencyKey: string;
      requestFingerprint: string;
      /** Canonical, secret-free pre-image of the validated request body. */
      preImage: string;
      workerId: string;
      classification: CommissioningDeliveryClassification;
      transient: boolean;
      disposition: CommissioningDisposition;
      canonicalRunId?: string;
      detail?: string;
    };

/**
 * Append-only, secret-free commissioning evidence. Nothing here carries a
 * bearer token, an `Authorization` header, or any request header at all — only
 * the ids, fingerprints, dispositions and the canonical request pre-image the
 * drill needs to reconcile every logical delivery to one canonical run.
 */
export class CommissioningEvidenceLog {
  private readonly entries: CommissioningEvidenceEntry[] = [];

  constructor(
    private readonly sink: (entry: CommissioningEvidenceEntry) => void = () => {},
    private readonly clock: () => number = () => Date.now(),
  ) {}

  private append(entry: CommissioningEvidenceEntry): void {
    this.entries.push(entry);
    this.sink(entry);
  }

  recordStepOutcome(outcome: OrchestrationOutcome): void {
    this.append({
      kind: "step-outcome",
      at: this.clock(),
      runId: outcome.runId,
      nodeId: outcome.nodeId,
      operationId: outcome.operationId,
      success: outcome.success,
      ...(outcome.failureCode === undefined ? {} : { failureCode: outcome.failureCode }),
    });
  }

  recordDelivery(
    entry: Omit<CommissioningEvidenceEntry & { kind: "delivery" }, "kind" | "at">,
  ): void {
    this.append({ kind: "delivery", at: this.clock(), ...entry });
  }

  /** `OrchestrationOutcomeRecorder` view for the runner. */
  asOutcomeRecorder(): OrchestrationOutcomeRecorder {
    return {
      record: async (outcome: OrchestrationOutcome) => {
        this.recordStepOutcome(outcome);
      },
    };
  }

  snapshot(): readonly CommissioningEvidenceEntry[] {
    return [...this.entries];
  }

  /** Per-disposition and per-classification tallies for the drill report. */
  tally(): {
    deliveries: number;
    byDisposition: Record<string, number>;
    firstAttempt: number;
    retries: number;
    transientFailures: number;
    creations: number;
    stepOutcomes: number;
  } {
    const byDisposition: Record<string, number> = {};
    let deliveries = 0;
    let firstAttempt = 0;
    let retries = 0;
    let transientFailures = 0;
    let creations = 0;
    let stepOutcomes = 0;
    for (const entry of this.entries) {
      if (entry.kind === "step-outcome") {
        stepOutcomes += 1;
        continue;
      }
      deliveries += 1;
      byDisposition[entry.disposition] = (byDisposition[entry.disposition] ?? 0) + 1;
      if (entry.classification === "first-attempt") firstAttempt += 1;
      else retries += 1;
      if (entry.transient) transientFailures += 1;
      if (entry.disposition === "created-complete" || entry.disposition === "created-failed") {
        creations += 1;
      }
    }
    return {
      deliveries,
      byDisposition,
      firstAttempt,
      retries,
      transientFailures,
      creations,
      stepOutcomes,
    };
  }
}
