import type { TotalityRequest } from "../runtime/totalityContracts.js";
import {
  OUTPUT_STYLES,
  TASK_TYPES,
  type OutputStyle,
  type TaskType,
  type ToolAuthority,
} from "../runtime/totalityPolicy.js";

export type TotalityReasonRequestBody = Omit<TotalityRequest, "requestId">;

const TOOL_AUTHORITIES: readonly ToolAuthority[] = ["T0", "T1", "T2", "T3"];

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function requiredString(value: unknown, field: string): string {
  if (typeof value !== "string" || value.trim().length === 0) {
    throw new Error(`${field} must be a non-empty string.`);
  }
  return value.trim();
}

function optionalProjectId(value: unknown): string | null {
  if (value === null) return null;
  return requiredString(value, "projectId");
}

function stringArray(value: unknown, field: string): string[] {
  if (!Array.isArray(value) || !value.every((item) => typeof item === "string")) {
    throw new Error(`${field} must be an array of strings.`);
  }
  return value.map((item) => item.trim()).filter((item) => item.length > 0);
}

function unknownArray(value: unknown, field: string): unknown[] {
  if (!Array.isArray(value)) throw new Error(`${field} must be an array.`);
  return [...value];
}

function taskType(value: unknown): TaskType {
  if (typeof value !== "string" || !TASK_TYPES.includes(value as TaskType)) {
    throw new Error("taskType is not supported.");
  }
  return value as TaskType;
}

function outputStyle(value: unknown): OutputStyle {
  if (typeof value !== "string" || !OUTPUT_STYLES.includes(value as OutputStyle)) {
    throw new Error("outputStyle is not supported.");
  }
  return value as OutputStyle;
}

function actionPolicy(value: unknown): TotalityRequest["actionPolicy"] {
  if (!isRecord(value)) throw new Error("actionPolicy must be an object.");
  const maximumToolAuthority = value.maximumToolAuthority;
  if (
    typeof maximumToolAuthority !== "string" ||
    !TOOL_AUTHORITIES.includes(maximumToolAuthority as ToolAuthority)
  ) {
    throw new Error("actionPolicy.maximumToolAuthority is not supported.");
  }
  if (typeof value.requireApprovalBeforeExecution !== "boolean") {
    throw new Error("actionPolicy.requireApprovalBeforeExecution must be boolean.");
  }
  return {
    maximumToolAuthority: maximumToolAuthority as ToolAuthority,
    requireApprovalBeforeExecution: value.requireApprovalBeforeExecution,
  };
}

export function parseTotalityReasonRequest(
  body: unknown,
  requestId: string,
): TotalityRequest {
  if (!isRecord(body)) throw new Error("Request body must be a JSON object.");

  return {
    requestId,
    projectId: optionalProjectId(body.projectId),
    sessionId: requiredString(body.sessionId, "sessionId"),
    taskType: taskType(body.taskType),
    domainContext: stringArray(body.domainContext, "domainContext"),
    goal: requiredString(body.goal, "goal"),
    constraints: unknownArray(body.constraints, "constraints"),
    inputs: unknownArray(body.inputs, "inputs"),
    outputStyle: outputStyle(body.outputStyle),
    actionPolicy: actionPolicy(body.actionPolicy),
  };
}
