import { z } from "zod";

import type { GoogleHomeAnnouncementProvider } from "../integrations/googleHome/googleHomeAnnouncementProvider.js";
import { MAX_TOOL_EXECUTION_TIMEOUT_MS, type ToolExecutionDefinition } from "./toolExecution.js";

export const HOME_ANNOUNCEMENT_TOOL = "home";
export const HOME_ANNOUNCEMENT_OPERATION = "announce";

/**
 * Speech synthesis, connecting, launching the media receiver, loading and
 * playing take well over the executor's 5 s default; at 5 s the receiver had
 * already been launched (interrupting any media) and the speech never played.
 */
export const ANNOUNCEMENT_EXECUTION_TIMEOUT_MS = MAX_TOOL_EXECUTION_TIMEOUT_MS;

export const homeAnnouncementArgumentsSchema = z
  .object({
    target: z.string().trim().min(1).max(120),
    message: z.string().trim().min(1).max(200),
    volume: z.number().min(0.05).max(0.8).optional(),
  })
  .strict();

export function createHomeAnnouncementToolDefinition(
  provider: GoogleHomeAnnouncementProvider,
): ToolExecutionDefinition {
  return {
    tool: HOME_ANNOUNCEMENT_TOOL,
    operation: HOME_ANNOUNCEMENT_OPERATION,
    externalProvider: provider.name,
    minimumAuthority: "T1",
    defaultTimeoutMs: ANNOUNCEMENT_EXECUTION_TIMEOUT_MS,
    schema: homeAnnouncementArgumentsSchema,
    async preflight(argumentsValue): Promise<void> {
      const parsed = homeAnnouncementArgumentsSchema.parse(argumentsValue);
      await provider.prepare(parsed);
    },
    async execute(argumentsValue, signal, context): Promise<unknown> {
      const parsed = homeAnnouncementArgumentsSchema.parse(argumentsValue);
      // Prepare again immediately before execution. This resolves the exact,
      // allowlisted device and creates the attempt identity before any audio
      // can be emitted. The authoritative execution layer records that identity
      // before sendPrepared crosses the external-effect boundary.
      const attempt = await provider.prepare(parsed);
      await context.registerProviderAttempt({
        provider: provider.name,
        providerRequestId: attempt.providerRequestId,
        providerCorrelationId: attempt.providerCorrelationId,
      });
      return provider.sendPrepared(attempt, parsed, signal);
    },
  };
}
