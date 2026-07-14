import type { ProjectMemory } from "./projectMemory.js";
import type {
  OutputStyle,
  PermissionEnvelope,
  RoutingDecision,
  TaskType,
} from "./totalityPolicy.js";
import type { ValidationReport } from "./validation.js";

export type TotalityStatus = "completed" | "partial" | "blocked" | "failed";

export interface ActionPolicy {
  maximumToolAuthority: PermissionEnvelope["toolAuthority"];
  requireApprovalBeforeExecution: boolean;
}

export interface TotalityRequest<TInput = unknown> {
  requestId: string;
  projectId: string | null;
  sessionId: string;
  taskType: TaskType;
  domainContext: string[];
  goal: string;
  constraints: unknown[];
  inputs: TInput[];
  outputStyle: OutputStyle;
  actionPolicy: ActionPolicy;
}

export interface MemoryUpdateProposal {
  operation: "create" | "update" | "append";
  target: keyof ProjectMemory;
  value: unknown;
  classification: "fact" | "assumption" | "measurement" | "decision" | "risk" | "task" | "event";
  requiresApproval: boolean;
}

export interface ToolActionRecord {
  actionId: string;
  tool: string;
  operation: string;
  state: "proposed" | "approved" | "executed" | "rejected" | "failed";
  destructive: boolean;
  idempotencyKey?: string;
}

export interface TotalityError {
  code: string;
  message: string;
  retryable: boolean;
}

export interface TotalityResponse<TResult = unknown> {
  requestId: string;
  status: TotalityStatus;
  routing: RoutingDecision;
  result: TResult | null;
  assumptions: string[];
  unknowns: string[];
  risks: string[];
  validation: ValidationReport;
  memoryUpdates: MemoryUpdateProposal[];
  toolActions: ToolActionRecord[];
  errors: TotalityError[];
}

export function assertRequestAuthority(
  request: TotalityRequest,
  routing: RoutingDecision,
): void {
  const authorityRank: Record<PermissionEnvelope["toolAuthority"], number> = {
    T0: 0,
    T1: 1,
    T2: 2,
    T3: 3,
  };

  if (
    authorityRank[routing.permission.toolAuthority] >
    authorityRank[request.actionPolicy.maximumToolAuthority]
  ) {
    throw new Error("Routing authority exceeds the request action policy");
  }

  if (
    request.actionPolicy.requireApprovalBeforeExecution &&
    routing.permission.actionState === "execute"
  ) {
    throw new Error("Execution requires approval under the request action policy");
  }
}
