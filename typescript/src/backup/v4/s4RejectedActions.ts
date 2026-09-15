import type { Value } from "convex/values";
import type { Doc } from "../../../convex/_generated/dataModel.js";
import { normaliseToolArguments } from "../../../convex/toolActionLogic.js";
import { safetyBindingForAction } from "../../../convex/toolActions.js";
import { createNoteArgumentsSchema } from "../../actions/createNoteTool.js";
import { encodeS4Payload } from "./convexCapture.js";
import type { S4ProjectNotesSource } from "./s4ProjectNotes.js";

const FIELDS = [
  "_id",
  "_creationTime",
  "ownerId",
  "actionId",
  "requestId",
  "projectKey",
  "baseRevision",
  "state",
  "tool",
  "operation",
  "arguments",
  "rationale",
  "requiredAuthority",
  "destructive",
  "idempotencyKey",
  "proposedBy",
  "rejectedBy",
  "rejectedReason",
  "createdAt",
  "updatedAt",
  "rejectedAt",
  "safetyBinding",
];
const text = (value: unknown): value is string =>
  typeof value === "string" && value.length > 0 && value === value.trim();
const same = (a: unknown, b: unknown) =>
  encodeS4Payload(a as Value).payloadJson === encodeS4Payload(b as Value).payloadJson;
/** Closed never-approved notes.create histories; no effect identity or authority is regenerated. */
export function validateS4RejectedActions(source: S4ProjectNotesSource): Set<Doc<"auditEvents">> {
  const projects = new Map(source.projects.map((row) => [row.projectKey, row]));
  const actions = new Map<string, Doc<"toolActions">>();
  const keys = new Set<string>();
  for (const row of source.toolActions) {
    const project = projects.get(row.projectKey);
    if (
      Object.keys(row).length !== FIELDS.length ||
      !FIELDS.every((field) => Object.hasOwn(row, field)) ||
      !project ||
      !text(row.actionId) ||
      !text(row.requestId) ||
      !text(row.rationale) ||
      !text(row.idempotencyKey) ||
      actions.has(row.actionId) ||
      keys.has(row.idempotencyKey) ||
      row.state !== "rejected" ||
      row.tool !== "notes" ||
      row.operation !== "create" ||
      row.requiredAuthority !== "T1" ||
      row.destructive !== false ||
      !["user", "agent", "tool"].includes(row.proposedBy) ||
      row.rejectedBy !== "user" ||
      !text(row.rejectedReason) ||
      !Number.isSafeInteger(row.baseRevision) ||
      row.baseRevision < 1 ||
      row.baseRevision > project.revision ||
      !Number.isFinite(row.createdAt) ||
      !Number.isFinite(row.rejectedAt) ||
      row.updatedAt !== row.rejectedAt ||
      row.updatedAt < row.createdAt
    )
      throw new Error("Unsupported or inconsistent rejected action history.");
    if (
      !createNoteArgumentsSchema.safeParse(row.arguments).success ||
      !same(row.arguments, normaliseToolArguments(row.arguments)) ||
      !same(row.safetyBinding, safetyBindingForAction("tool-stage", row, false))
    )
      throw new Error("Invalid rejected action arguments or safety binding.");
    actions.set(row.actionId, row);
    keys.add(row.idempotencyKey);
  }
  const consumed = new Set<Doc<"auditEvents">>();
  const seen = new Map<string, Set<string>>();
  for (const event of source.auditEvents) {
    if (!event.eventType.startsWith("tool.action.")) continue;
    const action =
      typeof event.payload.actionId === "string" ? actions.get(event.payload.actionId) : undefined;
    if (!action || event.scopeKey !== action.projectKey || event.requestId !== action.requestId)
      throw new Error("Audit rejected action reference does not resolve.");
    const history = seen.get(action.actionId) ?? new Set<string>();
    if (history.has(event.eventType)) throw new Error("Duplicate rejected action audit event.");
    if (event.eventType === "tool.action.proposed") {
      if (
        event.actor !== action.proposedBy ||
        event.createdAt !== action.createdAt ||
        !same(event.payload, {
          actionId: action.actionId,
          tool: action.tool,
          operation: action.operation,
          baseRevision: action.baseRevision,
          requiredAuthority: action.requiredAuthority,
          destructive: action.destructive,
          idempotencyKey: action.idempotencyKey,
          safetyBinding: action.safetyBinding,
        })
      )
        throw new Error("Invalid rejected action proposal audit.");
    } else if (event.eventType === "tool.action.rejected") {
      if (
        event.actor !== "user" ||
        event.createdAt !== action.rejectedAt ||
        !same(event.payload, { actionId: action.actionId, reason: action.rejectedReason })
      )
        throw new Error("Invalid rejected action rejection audit.");
    } else throw new Error("Unsupported rejected action audit history.");
    history.add(event.eventType);
    seen.set(action.actionId, history);
    consumed.add(event);
  }
  for (const action of actions.values()) {
    if (seen.get(action.actionId)?.size !== 2)
      throw new Error("Incomplete rejected action audit history.");
  }
  return consumed;
}
