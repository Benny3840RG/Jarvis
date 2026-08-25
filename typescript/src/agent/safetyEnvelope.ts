import { asNumber, type Payload } from "./types.js";

export interface SafetyContext {
  domain: string;
  action: string;
  payload: Payload;
  outputs: unknown[];
}

export interface SafetyResult {
  status: "ok" | "blocked" | "warning";
  reasons: string[];
}

function hasStatusForJob(
  value: unknown,
  jobId: unknown,
): value is { jobId: unknown; status: unknown } {
  return (
    typeof value === "object" &&
    value !== null &&
    "status" in value &&
    (("jobId" in value && (value as { jobId: unknown }).jobId === jobId) ||
      ("id" in value && (value as { id: unknown }).id === jobId))
  );
}

function isErrorOutput(value: unknown): value is { error: string } {
  return (
    typeof value === "object" &&
    value !== null &&
    "error" in value &&
    typeof (value as { error: unknown }).error === "string"
  );
}

function isActivatedScene(value: unknown): value is { activated: string } {
  return (
    typeof value === "object" &&
    value !== null &&
    "activated" in value &&
    typeof (value as { activated: unknown }).activated === "string"
  );
}

function isCompletedJob(value: unknown): boolean {
  return (
    typeof value === "object" &&
    value !== null &&
    "status" in value &&
    (value as { status: unknown }).status === "completed"
  );
}

function hasCompletionEvidence(value: unknown): boolean {
  return (
    typeof value === "object" &&
    value !== null &&
    "completionEvidenceRefs" in value &&
    Array.isArray((value as { completionEvidenceRefs: unknown }).completionEvidenceRefs) &&
    (value as { completionEvidenceRefs: unknown[] }).completionEvidenceRefs.some(
      (ref) => typeof ref === "string" && ref.trim().length > 0,
    )
  );
}

export class SafetyEnvelope {
  evaluate(ctx: SafetyContext): SafetyResult {
    const reasons: string[] = [];

    // Basic workshop rules (simulation, not real-world PPE/hazard enforcement).
    if (ctx.domain === "workshop") {
      if (ctx.action === "use_tool" && typeof ctx.payload.toolId !== "string") {
        reasons.push("Tool use requires toolId");
      }
      if (ctx.action === "consume_item" && asNumber(ctx.payload.quantity) <= 0) {
        reasons.push("Consume item requires positive quantity");
      }
    }

    // Simple cross-domain consistency check.
    if (ctx.domain === "business" && ctx.action === "complete_job") {
      const job = ctx.outputs.find((output) => hasStatusForJob(output, ctx.payload.jobId));
      if (job && job.status !== "completed") {
        reasons.push("Job completion output inconsistent");
      }
      if (job && job.status === "completed" && !hasCompletionEvidence(job)) {
        reasons.push("Job completion requires evidence");
      }
    }

    // Cross-domain consistency: a home scene must not be activated within a plan
    // unless that plan also completed a job.
    if (ctx.outputs.some(isActivatedScene) && !ctx.outputs.some(isCompletedJob)) {
      reasons.push("Home scene activated without a completed job");
    }

    // Output-consistency check: a step that returned an error is not a safe result.
    const errorCount = ctx.outputs.filter(isErrorOutput).length;
    if (errorCount > 0) {
      reasons.push(`${errorCount} step output(s) reported an error`);
    }

    if (reasons.length === 0) return { status: "ok", reasons: [] };

    const blocked = reasons.some((reason) => reason.toLowerCase().includes("requires"));
    return { status: blocked ? "blocked" : "warning", reasons };
  }
}
