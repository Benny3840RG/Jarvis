/**
 * Shared types for the Temporal PASS workflow prototype.
 *
 * Everything here is preview/experimental (see README.md). None of it is
 * imported by stable modules and it grants no Jarvis execution authority.
 */

// --- Mission lifecycle -------------------------------------------------

export type MissionStatus =
  "PENDING" | "RUNNING" | "AWAITING_APPROVAL" | "COMPLETED" | "FAILED" | "REJECTED" | "CANCELLED";

export type MissionPhase =
  | "PLANNING"
  | "BUILDING"
  | "REVIEWING"
  | "REWORKING"
  | "TESTING"
  | "TEST_REPAIRING"
  | "AWAITING_APPROVAL"
  | "MERGING"
  | "VERIFYING";

export interface MissionState {
  status: MissionStatus;
  phase: MissionPhase;
  iteration: number;
  completedSteps: string[];
  failedStep?: string;
  failureReason?: string;
}

export interface MissionIntent {
  id: string;
  type: "SIMPLE_ACTION" | "COMPLEX_MISSION";
  description: string;
  constraints?: {
    requireApproval?: boolean;
    /**
     * Overrides the default 72h approval wait. Production callers should
     * leave this unset; tests set it to a few hundred ms so PASS-11 doesn't
     * need a time-skipping test environment.
     */
    approvalTimeoutMs?: number;
  };
  context?: {
    repo?: string;
    branch?: string;
    prNumber?: number;
    /**
     * When set, the workflow executes this already-approved `quotes:send`
     * action through `GovernedExternalOperation` after owner approval and
     * before the still-mocked merge. The activity does not approve it.
     */
    governedQuoteSend?: {
      projectId: string;
      actionId: string;
      authority: "T0" | "T1" | "T2" | "T3";
    };
    [key: string]: unknown;
  };
  /**
   * Test-only knobs for the mocked REVIEW/TEST activities. Production
   * callers leave this unset (review/tests always pass first try in that
   * case). Exists so PASS-06/07/08 can deterministically exercise the
   * bounded rework/repair loops without a real reviewer.
   */
  scenario?: {
    /** executeReview reports changesRequired=true for this many calls (per mission), then true. */
    reviewChangesForCycles?: number;
    /** runTests reports passed=false for this many calls (per mission), then true. */
    testFailuresForCycles?: number;
    /** If set alongside testFailuresForCycles, the failures are reported as unrepairable. */
    testUnrepairable?: boolean;
    /** Holds executeBuild open (heartbeating) this long, so PASS-01 can kill the worker mid-activity. */
    buildDelayMs?: number;
    /**
     * Holds mergePR open (heartbeating) this long *after* the mock external
     * mutation has already happened but *before* the Activity returns — so
     * PASS-13 can kill the worker in the exact window where GitHub has
     * accepted the merge but Temporal hasn't yet durably recorded the
     * Activity's completion, and prove the retry reconciles instead of
     * duplicating or erroring.
     */
    mergeDelayMs?: number;
  };
}

// --- Agent / policy (mocked in Phase 1) ---------------------------------

export interface AgentConfig {
  identity: string;
  provider: string;
  model: string;
  runtime: string;
  role: "BUILDER" | "REVIEWER" | "EXECUTOR" | "PLANNER";
  capabilities: string[];
  permissions: {
    allowedTools: string[];
    deniedTools: string[];
    requireApprovalFor: string[];
  };
  budget: {
    maxTokens: number;
    maxCostCents?: number;
  };
}

export interface ToolRequest {
  agentIdentity: string;
  toolName: string;
  args: unknown;
  riskContext: {
    isReadOnly: boolean;
    isDestructive: boolean;
    isIdempotent: boolean;
    isOpenWorld: boolean;
  };
}

export interface ToolPermissionResult {
  allowed: boolean;
  reason?: string;
  requiresApproval?: boolean;
  approvalLevel?: "JARVIS" | "BENNY";
}

// --- Approval ------------------------------------------------------------

export type ApprovalDecision = "APPROVE" | "REJECT" | "MODIFY";

export interface ApprovalResponse {
  approvalId: string;
  missionId: string;
  candidateSha: string;
  decision: ApprovalDecision;
  /**
   * Which approval request this response answers: 0 for the initial
   * request, 1 for the single post-MODIFY re-request. The workflow only
   * applies a response whose approvalCycle matches the request currently
   * outstanding; anything else is stale/misdirected and is recorded but
   * ignored (see PASS-04).
   */
  approvalCycle: number;
  reasoning?: string;
  modifications?: {
    feedback: string;
    changes?: string[];
  };
}

// --- Activity input/output ------------------------------------------------

export interface BuildResult {
  commitSha: string;
  success: boolean;
}

export interface ReviewResult {
  changesRequired: boolean;
  feedback: string;
  severity: "MINOR" | "MAJOR" | "CRITICAL";
}

export interface TestResult {
  passed: boolean;
  isRepairable?: boolean;
  failureReason?: string;
}

export interface BuildInput {
  missionId: string;
  stepId: string;
  intent: MissionIntent;
}

export interface ReviewInput {
  missionId: string;
  stepId: string;
  buildResult: BuildResult;
  scenario?: MissionIntent["scenario"];
}

export interface ReworkInput {
  missionId: string;
  stepId: string;
  repo: string;
  buildResult: BuildResult;
  reviewResult: ReviewResult;
}

export interface TestInput {
  missionId: string;
  stepId: string;
  buildResult: BuildResult;
  scenario?: MissionIntent["scenario"];
}

export interface RepairInput {
  missionId: string;
  stepId: string;
  repo: string;
  buildResult: BuildResult;
  testResult: TestResult;
}

export interface ShaCheckInput {
  missionId: string;
  stepId: string;
  repo: string;
  branch: string;
}

export interface ShaCheckResult {
  sha: string;
}

export interface MergeInput {
  missionId: string;
  stepId: string;
  repo: string;
  prNumber: number;
  expectedSha: string;
  scenario?: MissionIntent["scenario"];
}

export interface NotifyInput {
  missionId: string;
  stepId: string;
  type: "BENNY_REQUEST" | "BENNY_APPROVED" | "BENNY_REJECTED";
  recipient: string;
  content: unknown;
}

export interface BranchProtectionInput {
  missionId: string;
  stepId: string;
  repo: string;
  branch: string;
}

export interface BranchProtectionResult {
  satisfied: boolean;
  reason?: string;
}
