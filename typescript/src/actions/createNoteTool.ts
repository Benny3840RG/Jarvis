import { z } from "zod";

import {
  NOTE_DOMAINS,
  NOTE_RETENTIONS,
  NOTE_SENSITIVITIES,
  type NoteStore,
} from "../notes/note.js";
import type { ToolExecutionDefinition } from "./toolExecution.js";

export const CREATE_NOTE_TOOL = "notes";
export const CREATE_NOTE_OPERATION = "create";

export const createNoteArgumentsSchema = z
  .object({
    title: z.string().trim().min(1).max(200),
    body: z.string().trim().min(1),
    tags: z.array(z.string().trim().min(1).max(50)).max(20).optional().default([]),
    domain: z.enum(NOTE_DOMAINS),
    sensitivity: z.enum(NOTE_SENSITIVITIES),
    retention: z.enum(NOTE_RETENTIONS).optional().default("standard"),
  })
  .strict();

export function createNoteToolDefinition(store: NoteStore): ToolExecutionDefinition {
  return {
    tool: CREATE_NOTE_TOOL,
    operation: CREATE_NOTE_OPERATION,
    schema: createNoteArgumentsSchema,
    async execute(argumentsValue, _signal, context) {
      const parsed = createNoteArgumentsSchema.parse(argumentsValue);
      return store.create({
        projectId: context.action.projectId,
        title: parsed.title,
        body: parsed.body,
        tags: parsed.tags,
        domain: parsed.domain,
        sensitivity: parsed.sensitivity,
        retention: parsed.retention,
        idempotencyKey: context.idempotencyKey,
        actionFingerprint: context.actionFingerprint,
        sourceRequestId: context.action.requestId,
        correlationId: context.correlationId,
        source: context.source,
      });
    },
  };
}
