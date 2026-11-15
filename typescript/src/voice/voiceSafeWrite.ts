/**
 * Safe voice writes stage onto the existing ToolAction service.
 * This module never approves, executes, or writes a second store.
 * Consequential proposals (quote send/draft, announcements) are not staged.
 */

import { canonicalJson } from "../actions/canonicalJson.js";
import { sha256Hex } from "../actions/sha256.js";
import { createErrandArgumentsSchema } from "../actions/errandTools.js";
import { createReminderArgumentsSchema } from "../actions/taskReminderTools.js";
import type { ToolActionService } from "../actions/toolActions.js";
import {
  classifyVoiceDictation,
  hasUnsafeVoiceCharacters,
  normalizeUtterancePreservingCase,
} from "./voiceDictation.js";
import { normalizeUtterance, type VoiceCommand } from "./voiceCommands.js";
import type { VoiceWriteTarget } from "./voiceWriteTarget.js";

/** NOLAN is the approved public wake word. Keep Jarvis temporarily for legacy clients. */
const WAKE_WORDS = ["nolan", "jarvis"] as const;
/** Punctuation or whitespace that may sit between the wake word and the command. */
const WAKE_SEPARATOR = /^[\s.,!?;:]+/;

/** Executors that exist on ToolExecutionService for the three spoken safe writes. */
const SAFE_EXECUTORS = new Set(["tasks:create", "reminders:create", "errands:create"]);

export const VOICE_WRITE_NO_WAKE_REASON = "Safe write was not staged: the wake word was not heard.";
export const VOICE_WRITE_UNCOMMISSIONED_REASON =
  "Safe write was not staged: the tool-action target is not commissioned.";
export const VOICE_WRITE_INCOMPLETE_REASON =
  "Safe write was not staged: the capture is missing a required field.";

export type VoiceWriteCapture = Readonly<{
  title?: string;
  category?: string;
  /** Spoken due text, preserved exactly as heard (dictated reminders only). */
  dueRaw?: string;
  /** Resolved due instant (ms since epoch); always paired with dueTimezone and dueRaw. */
  dueAt?: number;
  dueTimezone?: string;
}>;

/**
 * Split the wake word off an utterance. `rest` is normalised and lower-cased
 * for matching; `restCased` is the same span with the speaker's casing kept
 * (it equals `rest` whenever the two forms cannot be aligned safely).
 */
export function splitVoiceWakeWord(raw: string): {
  heard: boolean;
  rest: string;
  restCased: string;
} {
  const text = normalizeUtterance(raw);
  const cased = normalizeUtterancePreservingCase(raw);
  const casedSlice = (start: number, rest: string): string => {
    if (cased === undefined) return rest;
    const slice = cased.slice(start).trim();
    return slice.toLowerCase() === rest ? slice : rest;
  };
  for (const wakeWord of WAKE_WORDS) {
    if (text === wakeWord) return { heard: true, rest: "", restCased: "" };
    if (!text.startsWith(wakeWord)) continue;
    const after = text.slice(wakeWord.length);
    const separator = WAKE_SEPARATOR.exec(after);
    if (separator) {
      const rest = after.slice(separator[0].length).trim();
      return {
        heard: true,
        rest,
        restCased: casedSlice(wakeWord.length + separator[0].length, rest),
      };
    }
  }
  return { heard: false, rest: text, restCased: casedSlice(0, text) };
}

function unnormalisedDictation(raw: string, wakeHeard: boolean): string | undefined {
  if (!hasUnsafeVoiceCharacters(raw)) return undefined;
  let text = raw.trim();
  if (wakeHeard) {
    const lower = text.toLowerCase();
    const wake = WAKE_WORDS.find((word) => lower.startsWith(word));
    if (wake) text = text.slice(wake.length).replace(WAKE_SEPARATOR, "");
  }
  return classifyVoiceDictation(text, "client").status === "rejected" ? text : undefined;
}

export function voiceUtteranceForSession(input: {
  transcript: string;
  heardTranscript?: string;
  alternatives?: readonly string[];
}): { wakeAuthorized: boolean; transcript: string; alternatives?: string[] } {
  const direct = splitVoiceWakeWord(input.transcript);
  const commandTranscript = direct.heard ? direct.rest : normalizeUtterance(input.transcript);
  // The session matches on its own lower-cased normalisation; it receives the
  // speaker's casing so a dictated title keeps it ("Call Dave", not "Call dave").
  const casedCommand = direct.restCased;
  let wakeAuthorized = direct.heard && commandTranscript.length > 0;
  if (!wakeAuthorized && input.heardTranscript !== undefined) {
    const heard = splitVoiceWakeWord(input.heardTranscript);
    wakeAuthorized =
      heard.heard && heard.rest === commandTranscript && commandTranscript.length > 0;
  }
  // Normalisation collapses newline/tab/CR into spaces. A dictation that carried
  // them must reach the session unnormalised so it is rejected, not armed.
  const rawCommand = unnormalisedDictation(input.transcript, direct.heard);
  // Alternatives get the same treatment: a dictated alternative carrying raw
  // control characters is passed through stripped-but-unnormalised so the
  // session sees it and fails closed. Benign alternatives are unchanged.
  const alternatives = input.alternatives?.map((alternative) => {
    const split = splitVoiceWakeWord(alternative);
    return unnormalisedDictation(alternative, split.heard) ?? split.restCased;
  });
  return {
    wakeAuthorized,
    transcript: rawCommand ?? casedCommand,
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
    const candidate = {
      title,
      ...(capture?.dueRaw === undefined ? {} : { dueRaw: capture.dueRaw }),
      ...(capture?.dueAt === undefined ? {} : { dueAt: capture.dueAt }),
      ...(capture?.dueTimezone === undefined ? {} : { dueTimezone: capture.dueTimezone }),
    };
    // The executor's own schema decides: a due value that the executor would
    // refuse (dueAt without timezone or raw text) is never staged.
    return createReminderArgumentsSchema.safeParse(candidate).success ? candidate : undefined;
  }
  if (key === "errands:create") {
    // A spoken errand carries only its title; task and reminder fields never apply.
    if (
      capture?.category !== undefined ||
      capture?.dueRaw !== undefined ||
      capture?.dueAt !== undefined ||
      capture?.dueTimezone !== undefined
    ) {
      return undefined;
    }
    const candidate = { title: capture?.title?.trim() ?? "" };
    return createErrandArgumentsSchema.safeParse(candidate).success ? candidate : undefined;
  }
  return undefined;
}

function voiceSafeWriteActionId(input: {
  sessionId: string;
  commandId: string;
  projectId: string;
  expectedRevision: number;
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
  /** The owner's dedicated voice project, used when the request names no project. */
  target?: VoiceWriteTarget | null;
}): Promise<{ toolActionId: string } | { reason: string } | undefined> {
  if (!isSafeVoiceWrite(input.command) || !input.command.proposes) return undefined;
  if (!input.wakeAuthorized) return { reason: VOICE_WRITE_NO_WAKE_REASON };
  if (!input.service) return { reason: VOICE_WRITE_UNCOMMISSIONED_REASON };
  const explicit = input.projectId !== undefined || input.expectedRevision !== undefined;
  if (explicit && (!input.projectId || input.expectedRevision === undefined)) {
    return { reason: VOICE_WRITE_UNCOMMISSIONED_REASON };
  }
  if (!explicit && !input.target) return { reason: VOICE_WRITE_UNCOMMISSIONED_REASON };
  const argumentsValue = safeWriteArguments(input.command, input.capture);
  if (!argumentsValue) return { reason: VOICE_WRITE_INCOMPLETE_REASON };
  // An explicit request target keeps its existing meaning. Otherwise the
  // server resolves the dedicated voice project and its current revision now,
  // after the capture is known to be complete, so a stale or forged revision
  // can never come from the client.
  let projectId: string;
  let expectedRevision: number;
  if (explicit) {
    projectId = input.projectId as string;
    expectedRevision = input.expectedRevision as number;
  } else {
    const resolved = await (input.target as VoiceWriteTarget).resolve();
    if ("reason" in resolved) return { reason: resolved.reason };
    projectId = resolved.projectId;
    expectedRevision = resolved.expectedRevision;
  }
  const { tool, operation } = input.command.proposes;
  const actionId = voiceSafeWriteActionId({
    sessionId: input.sessionId,
    commandId: input.command.id,
    projectId,
    expectedRevision,
    tool,
    operation,
    arguments: argumentsValue,
  });
  const staged = await input.service.stage({
    actionId,
    requestId: actionId,
    projectId,
    expectedRevision,
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
