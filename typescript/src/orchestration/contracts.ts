import type { TotalityReasonRequestBody } from "../http/totalityRequest.js";
import type { Reminder, Task } from "../persistence/persistence.js";
import type { TotalityResponse } from "../runtime/totalityContracts.js";
import type { ToolAuthority } from "../runtime/totalityPolicy.js";
import type { OrchestrationTrigger } from "./trigger.js";

export type CreateTaskCommand = {
  operationId: "createTask";
  input: { title: string; category?: string };
};

export type CompleteTaskCommand = {
  operationId: "completeTask";
  input: { taskId: string };
};

export type CreateReminderCommand = {
  operationId: "createReminder";
  input: {
    title: string;
    due?: { text: string; timezone?: string };
  };
};

export type ReasonWithTotalityCommand = {
  operationId: "reasonWithTotality";
  input: TotalityReasonRequestBody;
};

export type OrchestrationCommand =
  CreateTaskCommand | CompleteTaskCommand | CreateReminderCommand | ReasonWithTotalityCommand;

export type OrchestrationValue = Task | Reminder | TotalityResponse<unknown>;

export type DomainFailureCode =
  | "blocked"
  | "not_found"
  | "invalid_transition"
  | "unauthorised"
  | "conflict"
  | "invalid_request"
  | "dependency_failure"
  | "postcondition_failed"
  | "audit_failure"
  | "execution_budget_exceeded";

export type DomainSuccess<T = OrchestrationValue> = {
  ok: true;
  value: T;
};

export type DomainFailure = {
  ok: false;
  code: DomainFailureCode;
  message: string;
  retryable: boolean;
};

export type DomainResult<T = OrchestrationValue> = DomainSuccess<T> | DomainFailure;

export type OrchestrationContext = {
  runId: string;
  authority: ToolAuthority;
  /** The validated trigger that created this run, when the caller has one. */
  trigger?: OrchestrationTrigger;
};

export interface OrchestrationExecutor {
  execute(command: OrchestrationCommand, context: OrchestrationContext): Promise<DomainResult>;
}

export type OrchestrationOutcome = {
  runId: string;
  nodeId: string;
  operationId: OrchestrationCommand["operationId"];
  success: boolean;
  failureCode?: DomainFailureCode;
};

export interface OrchestrationOutcomeRecorder {
  record(outcome: OrchestrationOutcome): Promise<void>;
}
