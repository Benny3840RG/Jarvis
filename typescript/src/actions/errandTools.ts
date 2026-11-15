import { z } from "zod";

import type { ErrandStore } from "../errands/errand.js";
import { sha256Hex } from "./sha256.js";
import type { ToolExecutionDefinition } from "./toolExecution.js";

export const ERRAND_TOOL = "errands";
export const CREATE_ERRAND_OPERATION = "create";

/**
 * A governed errand write: an open pick-up item with a title and, optionally,
 * a quantity and a note. Location and business-project links stay on the
 * owner's HTTP/HUD path; a ToolAction's projectId is the governing (Convex)
 * project, not an errand's business-project link, so it is never copied over.
 */
export const createErrandArgumentsSchema = z
  .object({
    title: z.string().trim().min(1).max(200),
    quantity: z.number().int().min(1).max(999).optional(),
    notes: z.string().trim().min(1).max(2000).optional(),
  })
  .strict();

/**
 * The errand id is derived from the approved action and its execution
 * idempotency key, so a retried execution (for example after a crash between
 * the write and the receipt) finds the same row instead of adding a second.
 * UUID-shaped, like the ids the store generates itself.
 */
export function errandIdForToolAction(input: {
  projectId: string;
  actionId: string;
  idempotencyKey: string;
}): string {
  const hex = sha256Hex(
    `errands:create:v1\u0000${input.projectId}\u0000${input.actionId}\u0000${input.idempotencyKey}`,
  );
  const variant = ((parseInt(hex[16] ?? "0", 16) & 0x3) | 0x8).toString(16);
  return [
    hex.slice(0, 8),
    hex.slice(8, 12),
    `5${hex.slice(13, 16)}`,
    `${variant}${hex.slice(17, 20)}`,
    hex.slice(20, 32),
  ].join("-");
}

export function createErrandToolDefinition(store: ErrandStore): ToolExecutionDefinition {
  return {
    tool: ERRAND_TOOL,
    operation: CREATE_ERRAND_OPERATION,
    schema: createErrandArgumentsSchema,
    async execute(argumentsValue, _signal, context) {
      const parsed = createErrandArgumentsSchema.parse(argumentsValue);
      const id = errandIdForToolAction({
        projectId: context.action.projectId,
        actionId: context.action.actionId,
        idempotencyKey: context.idempotencyKey,
      });
      const { errand } = await store.addOnce(id, {
        title: parsed.title,
        ...(parsed.quantity === undefined ? {} : { quantity: parsed.quantity }),
        ...(parsed.notes === undefined ? {} : { notes: parsed.notes }),
      });
      return errand;
    },
  };
}
