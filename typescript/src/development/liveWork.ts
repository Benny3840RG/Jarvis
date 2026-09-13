/** Read-only projection of authoritative Development state. ΩΣ readiness is
 * supplied by the shared durable completion derivation, never completion authority. */
import type { OmegaCompletionDecision } from "../omega/policy.js";
import type { DevelopmentState } from "./transitionRegistry.js";

/** Development states from which no further pipeline progress is possible. */
export const LIVE_WORK_TERMINAL_STATES: readonly DevelopmentState[] = [
  "COMPLETE",
  "ABORTED",
  "FAILED",
  "CONTRADICTED",
];

export type LiveWorkNodeStatus = "done" | "active" | "pending" | "blocked" | "unavailable";

export type LiveWorkNodeKey =
  "mission" | "stage" | "issue" | "pr" | "worker" | "review" | "ci" | "merge" | "omega";

export interface LiveWorkNode {
  readonly key: LiveWorkNodeKey;
  readonly label: string;
  readonly status: LiveWorkNodeStatus;
  readonly detail: string;
}

export interface LiveWorkEvent {
  readonly evidenceIds: readonly string[];
  readonly eventId: string;
  readonly at: string;
  readonly summary: string;
}

export interface LiveWorkRailNode {
  readonly state: DevelopmentState;
  readonly label: string;
  readonly status: LiveWorkNodeStatus;
}

export interface LiveWorkCandidate {
  readonly pullRequestNumber: number;
  readonly headSha: string;
  readonly receiptId: string;
}

export interface LiveWorkPipeline {
  readonly candidate: LiveWorkCandidate | null;
  readonly rail: readonly LiveWorkRailNode[];
  /**
   * State + ΩΣ-readiness headline, e.g. `"MERGED — ΩΣ READY"`. Never claims
   * Development completion from ΩΣ readiness — only a real
   * `DEV_TRANSITION_MERGED_TO_COMPLETE` makes the state `COMPLETE`.
   */
  readonly completionLabel: string;
  readonly omegaReadiness: OmegaCompletionDecision;
  readonly subjectVersion: number | null;
  readonly orchestrationRunId: string | null;
  readonly orchestrationNodeId: string | null;
  readonly fencingToken: number | null;
  readonly workerStep: LiveWorkWorkerStepRow | null;
  readonly subjectId: string;
  readonly state: DevelopmentState;
  readonly repository: string | null;
  readonly branch: string | null;
  readonly objective: string | null;
  readonly missionInFlight: boolean;
  readonly nodes: readonly LiveWorkNode[];
  readonly events: readonly LiveWorkEvent[];
  readonly updatedAt: string;
  readonly generatedAt: string;
}

/** The canonical happy-path Development progression shown as a linear rail. */
export const LIVE_WORK_RAIL_STATES: readonly DevelopmentState[] = [
  "IDEA",
  "SPECIFIED",
  "READY",
  "CLAIMED",
  "BUILDING",
  "VERIFYING",
  "REVIEW",
  "READY_TO_MERGE",
  "MERGED",
  "COMPLETE",
];

export class DevelopmentLiveWorkUnavailableError extends Error {}

export type LiveWorkResult =
  | { readonly status: "available"; readonly pipeline: LiveWorkPipeline | null }
  | { readonly status: "unavailable"; readonly reason: string };

/** Raw subject projection returned by `developmentState.liveWork`. */
export interface LiveWorkSubjectRow {
  readonly subjectVersion?: number;
  readonly orchestrationRunId?: string;
  readonly orchestrationNodeId?: string;
  readonly fencingToken?: number;
  readonly subjectId: string;
  readonly state: DevelopmentState;
  readonly repository?: string;
  readonly branch?: string;
  readonly updatedAt: number;
}

/** Raw event projection (safe fields only — never the full payload). */
export interface LiveWorkEventRow {
  readonly evidenceIds?: readonly string[];
  readonly eventId: string;
  readonly eventType: string;
  readonly transitionId?: string;
  readonly occurredAt: string;
  readonly from?: string;
  readonly to?: string;
  readonly reasonCodes: readonly string[];
  readonly hasMergeReceipt: boolean;
}

export interface LiveWorkOmegaRow {
  readonly missionId: string;
  readonly objective: string;
  readonly state: string;
  readonly acceptanceCriteria: readonly { readonly status: string }[];
}

export interface LiveWorkWorkerStepRow {
  readonly nodeId: string;
  readonly operationId?: string | null;
  readonly state: string;
  readonly leaseOwner?: string | null;
  readonly leaseExpiresAt?: number | null;
}

export interface LiveWorkSnapshot {
  readonly candidate?: LiveWorkCandidate | null;
  readonly omegaReadiness?: OmegaCompletionDecision;
  readonly subject: LiveWorkSubjectRow;
  readonly events: readonly LiveWorkEventRow[];
  readonly omegaMission: LiveWorkOmegaRow | null;
  readonly workerStep: LiveWorkWorkerStepRow | null;
  readonly generatedAt: string;
}

const NOT_RECORDED = "Not recorded by the mission yet.";

/**
 * Canonical linear position of each development state along the pipeline.
 * Off-track states (`REPAIR_REQUIRED`, `INDETERMINATE`, `FAILED`, ...) are
 * pinned to the position they diverged from so the nodes behind them still
 * read as `done`.
 */
const STATE_ORDER: Record<DevelopmentState, number> = {
  IDEA: 0,
  SPECIFIED: 1,
  READY: 2,
  CLAIMED: 3,
  BUILDING: 4,
  VERIFYING: 5,
  REPAIR_REQUIRED: 4,
  REVIEW: 6,
  READY_TO_MERGE: 7,
  INDETERMINATE: 7,
  MERGED: 8,
  CONTRADICTED: 8,
  FAILED: 4,
  ABORTED: 3,
  COMPLETE: 9,
};

const BLOCKED_STATES = new Set<DevelopmentState>([
  "REPAIR_REQUIRED",
  "INDETERMINATE",
  "FAILED",
  "CONTRADICTED",
  "ABORTED",
]);

export function isLiveWorkMissionInFlight(state: DevelopmentState): boolean {
  return !LIVE_WORK_TERMINAL_STATES.includes(state);
}

function phaseStatus(
  currentOrder: number,
  reachedOrder: number,
  start: number,
  end: number,
  blocked: boolean,
): LiveWorkNodeStatus {
  if (blocked) return "blocked";
  if (reachedOrder > end || currentOrder > end) return "done";
  if (currentOrder >= start) return "active";
  return "pending";
}

/**
 * The furthest pipeline position this mission has demonstrably reached,
 * derived from the `from`/`to` states of its recorded transition events (not
 * just the current state, which off-track states pin backwards). Bounded by
 * the event tail the query returns; omitted history never supplies evidence.
 */
function reachedPipelineOrder(events: readonly LiveWorkEventRow[], currentOrder: number): number {
  let reached = currentOrder;
  // Repair starts a new candidate attempt. Earlier verification/review cannot
  // be presented as verification of the rebuilt candidate.
  let attemptStart = 0;
  for (let index = 0; index < events.length; index++) {
    const event = events[index];
    if (
      event?.eventType === "DEV_TRANSITION_COMMITTED" &&
      (event.to === "BUILDING" || event.to === "REPAIR_REQUIRED")
    )
      attemptStart = index;
  }
  for (const event of events.slice(Math.max(0, attemptStart))) {
    if (event.eventType !== "DEV_TRANSITION_COMMITTED") continue;
    const labels = event.to === "REPAIR_REQUIRED" ? [event.to] : [event.from, event.to];
    for (const label of labels) {
      if (
        label !== undefined &&
        label in STATE_ORDER &&
        (!BLOCKED_STATES.has(label as DevelopmentState) || label === "REPAIR_REQUIRED")
      ) {
        reached = Math.max(reached, STATE_ORDER[label as DevelopmentState]);
      }
    }
  }
  return reached;
}

/** Which pipeline node a blocked state most specifically stalls. */
function blockedNode(
  state: DevelopmentState,
  lastTransitionId: string | undefined,
): LiveWorkNodeKey | null {
  switch (state) {
    case "REPAIR_REQUIRED":
      return lastTransitionId === "DEV_TRANSITION_REVIEW_TO_REPAIR_REQUIRED" ? "review" : "ci";
    case "INDETERMINATE":
      return "merge";
    case "FAILED":
      return "merge";
    case "CONTRADICTED":
      return "omega";
    case "ABORTED":
      return "stage";
    default:
      return null;
  }
}

function summariseEvent(row: LiveWorkEventRow): string {
  if (row.eventType === "DEV_TRANSITION_COMMITTED") {
    const move =
      row.from && row.to ? `${row.from} → ${row.to}` : (row.transitionId ?? "transition");
    return `Committed: ${move}${row.hasMergeReceipt ? " (merge receipt)" : ""}`;
  }
  if (row.eventType === "DEV_TRANSITION_REJECTED") {
    const codes = row.reasonCodes.length ? row.reasonCodes.join(", ") : "no reason recorded";
    return `Rejected: ${codes}`;
  }
  return `${row.eventType} event`;
}

/**
 * Folds one mission's authoritative state into the nine-node pipeline. Pure:
 * the same snapshot always produces the same pipeline.
 */
export function foldLiveWorkPipeline(snapshot: LiveWorkSnapshot): LiveWorkPipeline {
  const { subject, events, omegaMission, workerStep } = snapshot;
  const order = STATE_ORDER[subject.state];
  const reached = reachedPipelineOrder(events, order);
  const missionInFlight = isLiveWorkMissionInFlight(subject.state);
  const isComplete = subject.state === "COMPLETE";
  const stateBlocked = BLOCKED_STATES.has(subject.state);

  const lastTransitionId = [...events]
    .reverse()
    .find(
      (e) => e.eventType === "DEV_TRANSITION_COMMITTED" && e.transitionId !== undefined,
    )?.transitionId;
  const blocked = stateBlocked ? blockedNode(subject.state, lastTransitionId) : null;

  const repository = subject.repository ?? null;
  const branch = subject.branch ?? null;

  const missionStatus: LiveWorkNodeStatus = isComplete
    ? "done"
    : subject.state === "ABORTED" || subject.state === "FAILED" || subject.state === "CONTRADICTED"
      ? "blocked"
      : "active";

  const stageStatus: LiveWorkNodeStatus = isComplete ? "done" : stateBlocked ? "blocked" : "active";

  const workerActive = order >= STATE_ORDER.CLAIMED && order <= STATE_ORDER.VERIFYING;
  const leaseExpired =
    workerStep?.leaseExpiresAt != null &&
    workerStep.leaseExpiresAt <= Date.parse(snapshot.generatedAt);
  const workerStatus: LiveWorkNodeStatus =
    !missionInFlight && !isComplete
      ? "blocked"
      : workerActive && (!workerStep?.leaseOwner || workerStep.leaseExpiresAt == null)
        ? "unavailable"
        : workerActive && leaseExpired
          ? "blocked"
          : phaseStatus(order, reached, STATE_ORDER.CLAIMED, STATE_ORDER.VERIFYING, false);
  const workerDetail =
    !missionInFlight && !isComplete
      ? `Development is ${subject.state}; this mission is terminal.`
      : workerStep?.leaseOwner
        ? `${workerStep.leaseOwner} · step ${workerStep.state}${leaseExpired ? " (lease expired)" : ""}`
        : missionInFlight && workerActive
          ? "Worker lease not recorded."
          : NOT_RECORDED;

  const nodes: LiveWorkNode[] = [
    {
      key: "mission",
      label: "CURRENT MISSION",
      status: missionStatus,
      detail: omegaMission?.objective ?? subject.subjectId,
    },
    {
      key: "stage",
      label: "STAGE",
      status: stageStatus,
      detail: subject.state,
    },
    {
      key: "issue",
      label: "MISSION",
      status: phaseStatus(order, reached, STATE_ORDER.IDEA, STATE_ORDER.READY, false),
      detail: repository ? `${subject.subjectId} · ${repository}` : subject.subjectId,
    },
    {
      key: "pr",
      label: "PR",
      status: snapshot.candidate
        ? phaseStatus(order, reached, STATE_ORDER.CLAIMED, STATE_ORDER.READY_TO_MERGE, false)
        : "unavailable",
      detail: snapshot.candidate
        ? `PR #${snapshot.candidate.pullRequestNumber} · ${snapshot.candidate.headSha} · ${snapshot.candidate.receiptId}`
        : NOT_RECORDED,
    },
    {
      key: "worker",
      label: "WORKER",
      status: workerStatus,
      detail: workerDetail,
    },
    {
      key: "review",
      label: "REVIEW",
      status: phaseStatus(
        order,
        reached,
        STATE_ORDER.REVIEW,
        STATE_ORDER.REVIEW,
        blocked === "review",
      ),
      detail:
        blocked === "review"
          ? "Review found blocking findings; repair required."
          : order > STATE_ORDER.REVIEW
            ? "Independent review complete."
            : order === STATE_ORDER.REVIEW
              ? "Independent review in progress."
              : "Awaiting review.",
    },
    {
      key: "ci",
      label: "CI",
      status: phaseStatus(
        order,
        reached,
        STATE_ORDER.VERIFYING,
        STATE_ORDER.VERIFYING,
        blocked === "ci",
      ),
      detail:
        blocked === "ci"
          ? "Verification failed; repair required."
          : order > STATE_ORDER.VERIFYING
            ? "Verification checks passed."
            : order === STATE_ORDER.VERIFYING
              ? "Verification checks running."
              : "Awaiting verification.",
    },
    {
      key: "merge",
      label: "MERGE",
      status:
        subject.state === "MERGED" || isComplete
          ? "done"
          : blocked === "merge" || blocked === "omega"
            ? "blocked"
            : phaseStatus(order, reached, STATE_ORDER.READY_TO_MERGE, STATE_ORDER.MERGED, false),
      detail:
        subject.state === "CONTRADICTED"
          ? "Development is CONTRADICTED; inspect durable evidence."
          : subject.state === "INDETERMINATE"
            ? "Merge outcome indeterminate; reconciliation open."
            : subject.state === "FAILED"
              ? "Development failed; inspect recorded transition evidence."
              : subject.state === "MERGED" || isComplete
                ? "Merged and reconciled."
                : order === STATE_ORDER.READY_TO_MERGE
                  ? "Ready to merge."
                  : "Awaiting merge.",
    },
    {
      key: "omega",
      label: "ΩΣ",
      status: isComplete
        ? "done"
        : blocked === "omega" ||
            omegaMission?.state === "blocked" ||
            omegaMission?.state === "degraded"
          ? "blocked"
          : subject.state === "MERGED"
            ? "active"
            : "pending",
      detail: isComplete
        ? "COMPLETE"
        : subject.state === "CONTRADICTED"
          ? "CONTRADICTED — completion evidence requires reconciliation."
          : snapshot.omegaReadiness?.allowed
            ? "ΩΣ READY — awaiting authoritative completion"
            : `ΩΣ NOT READY: ${(snapshot.omegaReadiness?.failures ?? ["omega-readiness-unavailable"]).join(", ")}`,
    },
  ];

  const foldedEvents: LiveWorkEvent[] = [...events]
    .reverse()
    .slice(0, 12)
    .map((row) => ({
      eventId: row.eventId,
      evidenceIds: row.evidenceIds ?? [],
      at: row.occurredAt,
      summary: summariseEvent(row),
    }));

  const omegaReadiness = snapshot.omegaReadiness ?? {
    allowed: false,
    failures: ["omega-readiness-unavailable"],
  };
  const railOrder = stateBlocked ? reachedPipelineOrder(events, 0) : order;
  const rail: LiveWorkRailNode[] = LIVE_WORK_RAIL_STATES.map((state) => ({
    state,
    label: state === "IDEA" ? "MISSION" : state === "COMPLETE" ? "ΩΣ" : state.replaceAll("_", " "),
    // Highlight only the persisted state. Past phases are a lifecycle position,
    // not fabricated verification or provider receipts. Off-rail history must
    // come from committed events in the current candidate attempt.
    status:
      state === subject.state
        ? isComplete
          ? "done"
          : "active"
        : STATE_ORDER[state] < railOrder
          ? "done"
          : "pending",
  }));
  if (stateBlocked) rail.push({ state: subject.state, label: subject.state, status: "blocked" });
  const completionLabel = isComplete
    ? "COMPLETE"
    : subject.state === "MERGED"
      ? `MERGED — ΩΣ ${omegaReadiness.allowed ? "READY" : "NOT READY"}`
      : subject.state;
  return {
    candidate: snapshot.candidate ?? null,
    rail,
    completionLabel,
    omegaReadiness,
    subjectVersion: subject.subjectVersion ?? null,
    orchestrationRunId: subject.orchestrationRunId ?? null,
    orchestrationNodeId: subject.orchestrationNodeId ?? null,
    fencingToken: subject.fencingToken ?? null,
    workerStep,
    subjectId: subject.subjectId,
    state: subject.state,
    repository,
    branch,
    objective: omegaMission?.objective ?? null,
    missionInFlight,
    nodes,
    events: foldedEvents,
    updatedAt: new Date(subject.updatedAt).toISOString(),
    generatedAt: snapshot.generatedAt,
  };
}

export interface DevelopmentLiveWorkSource {
  /** Returns the current in-flight mission snapshot, or `null` when none exists. */
  readLiveWorkSnapshot(): Promise<LiveWorkSnapshot | null>;
}

/**
 * Reads the live-work pipeline. A read failure is reported as
 * `{status: "unavailable", reason}` — never thrown, never an empty pipeline.
 * "No mission in flight" is a distinct, truthful `{status: "available",
 * pipeline: null}` — the link works, there is simply nothing running.
 */
export async function readLiveWorkPipeline(input: {
  source: DevelopmentLiveWorkSource;
}): Promise<LiveWorkResult> {
  let snapshot: LiveWorkSnapshot | null;
  try {
    snapshot = await input.source.readLiveWorkSnapshot();
  } catch (error) {
    return {
      status: "unavailable",
      reason:
        error instanceof DevelopmentLiveWorkUnavailableError
          ? error.message
          : "Live-work state is temporarily unavailable.",
    };
  }
  if (!snapshot) {
    return { status: "available", pipeline: null };
  }
  try {
    return { status: "available", pipeline: foldLiveWorkPipeline(snapshot) };
  } catch {
    return { status: "unavailable", reason: "Live-work state is invalid or unavailable." };
  }
}
