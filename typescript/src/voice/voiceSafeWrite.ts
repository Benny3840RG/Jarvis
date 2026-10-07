/**
 * Safe voice writes stage onto the existing ToolAction service.
 * This module never approves, executes, or writes a second store.
 * Consequential proposals (quote send/draft, announcements, errands without
 * a ToolAction executor) are not staged.
 */

import { canonicalJson } from "../actions/canonicalJson.js";
import { sha256Hex } from "../actions/sha256.js";
import type { ToolActionService } from "../actions/toolActions.js";
import { normalizeUtterance, type VoiceCommand } from "./voiceCommands.js";

const WAKE_WORD = "jarvis";

/** Executors that already exist on ToolExecutionService. Errands are absent. */
const SAFE_EXECUTORS = new Set(["tasks:create", "reminders:create"]);

export const VOICE_WRITE_NO_WAKE_REASON = "Safe write was not staged: the wake word was not heard.";
export const VOICE_WRITE_UNCOMMISSIONED_REASON =
  "Safe write was not staged: the tool-action target is not commissioned.";
export const VOICE_WRITE_INCOMPLETE_REASON =
  "Safe write was not staged: the capture is missing a required field.";

export type VoiceWriteCapture = Readonly<{
  title?: string;
  category?: string;
}>;

export function splitVoiceWakeWord(raw: string): { heard: boolean; rest: string } {
  const text = normalizeUtterance(raw);
  if (text === WAKE_WORD) return { heard: true, rest: "" };
  if (text.startsWith(`${WAKE_WORD} `)) {
    return { heard: true, rest: text.slice(WAKE_WORD.length + 1).trim() };
  }
  return { heard: false, rest: text };
}

export function voiceUtteranceForSession(input: {
  transcript: string;
  heardTranscript?: string;
  alternatives?: readonly string[];
}): { wakeAuthorized: boolean; transcript: string; alternatives?: string[] } {
  const direct = splitVoiceWakeWord(input.transcript);
  const commandTranscript = direct.heard ? direct.rest : normalizeUtterance(input.transcript);
  let wakeAuthorized = direct.heard && commandTranscript.length > 0;
  if (!wakeAuthorized && input.heardTranscript !== undefined) {
    const heard = splitVoiceWakeWord(input.heardTranscript);
    wakeAuthorized =
      heard.heard && heard.rest === commandTranscript && commandTranscript.length > 0;
  }
  const alternatives = input.alternatives?.map(
    (alternative) => splitVoiceWakeWord(alternative).rest,
  );
  return {
    wakeAuthorized,
    transcript: commandTranscript,
    ...(alternatives ? { alternatives } : {}),
  };
}

export function isSafeVoiceWrite(command: VoiceCommand): boolean {
  if (command.kind !== "propose" || !command.proposes) return false;
  return SAFE_EXECUTORS.has(`${command.proposes.tool}:${command.proposes.operation}`);
}

function safeWriteArguments(
  command: VoiceCommand,
  capture: VoiceWriteCapture | undefined,
): Record<string, unknown> | undefined {
  const key = `${command.proposes?.tool}:${command.proposes?.operation}`;
  if (key === "tasks:create") {
    const title = capture?.title?.trim() ?? "";
    const category = capture?.category?.trim() ?? "";
    if (title.length < 1 || title.length > 200 || category.length < 1 || category.length > 100) {
      return undefined;
    }
    return { title, category };
  }
  if (key === "reminders:create") {
    const title = capture?.title?.trim() ?? "";
    if (title.length < 1 || title.length > 200) return undefined;
    return { title };
  }
  return undefined;
}

function voiceSafeWriteActionId(input: {
  sessionId: string;
  commandId: string;
  projectId: string;
  tool: string;
  operation: string;
  arguments: Record<string, unknown>;
}): string {
  return `voice-safe-write:v1:${sha256Hex(canonicalJson(input))}`;
}

export async function stageVoiceSafeWrite(input: {
  service: ToolActionService | null | undefined;
  sessionId: string;
  command: VoiceCommand;
  wakeAuthorized: boolean;
  projectId?: string;
  expectedRevision?: number;
  capture?: VoiceWriteCapture;
}): Promise<{ toolActionId: string } | { reason: string } | undefined> {
  if (!isSafeVoiceWrite(input.command) || !input.command.proposes) return undefined;
  if (!input.wakeAuthorized) return { reason: VOICE_WRITE_NO_WAKE_REASON };
  if (!input.service || !input.projectId || input.expectedRevision === undefined) {
    return { reason: VOICE_WRITE_UNCOMMISSIONED_REASON };
  }
  const argumentsValue = safeWriteArguments(input.command, input.capture);
  if (!argumentsValue) return { reason: VOICE_WRITE_INCOMPLETE_REASON };
  const { tool, operation } = input.command.proposes;
  const actionId = voiceSafeWriteActionId({
    sessionId: input.sessionId,
    commandId: input.command.id,
    projectId: input.projectId,
    tool,
    operation,
    arguments: argumentsValue,
  });
  const staged = await input.service.stage({
    actionId,
    requestId: actionId,
    projectId: input.projectId,
    expectedRevision: input.expectedRevision,
    tool,
    operation,
    arguments: argumentsValue,
    rationale: `Voice safe write ${input.command.id}`,
    requiredAuthority: "T1",
    destructive: false,
    idempotencyKey: actionId,
    proposedBy: "user",
  });
  return { toolActionId: staged.actionId };
}
