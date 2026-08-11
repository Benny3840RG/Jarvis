import type { ToolAuthority } from "../runtime/totalityPolicy.js";
import type { SafetyBinding } from "../safety/safetyBinder.js";

export type ToolActionState = "proposed" | "approved" | "rejected" | "expired" | "revoked";
export type ToolActionActor = "user" | "agent" | "tool";
export type ApprovalExpiryPolicy = "ttl" | "non-expiring";
export type ConsumptionPolicy = "single-use" | "reusable";

export type ToolAction = {
  actionId: string;
  requestId: string;
  projectId: string;
  baseRevision: number;
  state: ToolActionState;
  tool: string;
  operation: string;
  arguments: Record<string, unknown>;
  rationale: string;
  requiredAuthority: ToolAuthority;
  destructive: boolean;
  idempotencyKey: string;
  proposedBy: ToolActionActor;
  approvedBy?: "user";
  rejectedBy?: "user";
  rejectedReason?: string;
  createdAt: string;
  updatedAt: string;
  approvedAt?: string;
  rejectedAt?: string;
  // Consent lifecycle (R-048/R-049/R-050) — absent on legacy/pre-existing rows.
  approvalExpiryPolicy?: ApprovalExpiryPolicy;
  approvalExpiresAt?: string;
  expiredObservedAt?: string;
  consumptionPolicy?: ConsumptionPolicy;
  revokedBy?: "user";
  revokedReason?: string;
  revokedAt?: string;
  safetyBinding?: SafetyBinding;
  /** Computed, read-only view field: true when an approval's ttl has lapsed but the transition hasn't been persisted yet. */
  isApprovalExpired?: boolean;
};

export interface ToolActionService {
  stage(input: {
    actionId: string;
    requestId: string;
    projectId: string;
    expectedRevision: number;
    tool: string;
    operation: string;
    arguments: Record<string, unknown>;
    rationale: string;
    requiredAuthority: ToolAuthority;
    destructive: boolean;
    idempotencyKey: string;
    proposedBy: ToolActionActor;
  }): Promise<ToolAction>;
  get(input: { actionId: string; projectId: string }): Promise<ToolAction | null>;
  list(input: {
    projectId: string;
    state?: ToolActionState;
    limit?: number;
  }): Promise<ToolAction[]>;
  approve(input: {
    actionId: string;
    projectId: string;
    expectedRevision: number;
    approvalToken: string;
  }): Promise<ToolAction>;
  reject(input: { actionId: string; projectId: string; reason: string }): Promise<ToolAction>;
  /**
   * Optional on the interface (rather than required, like the other methods)
   * so existing `ToolActionService` implementations/fakes elsewhere in the
   * codebase don't need updating before this capability has an HTTP route —
   * that wiring is a deferred follow-up. `ConvexToolActionService` always
   * implements it.
   */
  revoke?(input: {
    actionId: string;
    projectId: string;
    reason: string;
    approvalToken: string;
  }): Promise<ToolAction>;
}
