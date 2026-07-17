import type { ToolAuthority } from "../runtime/totalityPolicy.js";

export type ToolActionState = "proposed" | "approved" | "rejected";
export type ToolActionActor = "user" | "agent" | "tool";

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
  }): Promise<ToolAction>;
  reject(input: { actionId: string; projectId: string; reason: string }): Promise<ToolAction>;
}
