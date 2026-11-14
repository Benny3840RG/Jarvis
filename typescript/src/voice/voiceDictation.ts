/**
 * NOLAN voice — spoken capture for safe writes (#567, #811).
 *
 * The guarded catalog matches whole utterances exactly, so "Nolan, add a task:
 * order bar oil" used to lose everything after "add a task" and could never
 * stage anything. This module adds a deliberately narrow, deterministic
 * dictation grammar for the two safe writes that already have ToolAction
 * executors (`tasks:create`, `reminders:create`) and nothing else.
 *
 * Safety contract:
 *   - Pure and side-effect free. It returns a capture proposal only.
 *   - Only the client profile's safe-write commands can be dictated. Queries,
 *     actuation, quote send/draft and errands (no executor) are never reachable.
 *   - The command prefix is anchored at the start of the utterance; a sentence
 *     can never smuggle a dictation in from the middle ("don't add a task ...").
 *   - The dictated text is data, never a command: it may not contain a wake
 *     word, may not be a confirm/cancel phrase, and is length-bounded to the
 *     executor schema (title 1..200).
 *   - The session always reads the capture back and waits for an explicit
 *     spoken confirmation. Confirming only STAGES a ToolAction; the owner
 *     approval path is unchanged and voice never approves or executes.
 */

import {
  VOICE_COMMANDS,
  VOICE_CONTROL_PHRASES,
  normalizeUtterance,
  type VoiceCommand,
  type VoiceProfile,
} from "./voiceCommands.js";
import type { VoiceWriteCapture } from "./voiceSafeWrite.js";

/** Task categories the HUD capture form offers. */
export const VOICE_TASK_CATEGORIES = ["personal", "work", "builds", "money", "life"] as const;
export type VoiceTaskCategory = (typeof VOICE_TASK_CATEGORIES)[number];

/** Same default as the HUD capture form's first option; always read back before staging. */
export const DEFAULT_VOICE_TASK_CATEGORY: VoiceTaskCategory = "personal";

const MAX_TITLE_LENGTH = 200;

const TASK_COMMAND_ID = "client.capture-task";
const REMINDER_COMMAND_ID = "client.follow-up-reminder";

const CATEGORY_ALIASES: ReadonlyMap<string, VoiceTaskCategory> = new Map([
  ["personal", "personal"],
  ["work", "work"],
  ["job", "work"],
  ["build", "builds"],
  ["builds", "builds"],
  ["money", "money"],
  ["finance", "money"],
  ["life", "life"],
  ["home", "life"],
]);

/**
 * "add a task: X", "add a work task X", "new task, X", "capture a build task to X".
 * Group 1 is an optional category word; group 2 is the dictated title.
 */
const TASK_PATTERN =
  /^(?:(?:add|capture|create|make|put)(?: (?:a|an|another|me a))?|new) (?:([a-z]+) )?task(?: (?:to|for|called|saying|that says))?[\s:,-]+(.+)$/;

/** "remind me to X", "add a reminder to X", "set a reminder to X", "reminder to X". */
const REMINDER_PATTERN =
  /^(?:remind me to|(?:add|set|make|create) (?:a |me a )?reminder to|reminder to|new reminder to)[\s:,-]+(.+)$/;

/** Words that may sit before "task" without naming a category. */
const CATEGORY_FILLERS: ReadonlySet<string> = new Set(["new", "quick"]);

const WAKE_TOKEN = /\b(?:nolan|jarvis)\b/;

const CONTROL_PHRASES: ReadonlySet<string> = new Set([
  ...VOICE_CONTROL_PHRASES.confirm,
  ...VOICE_CONTROL_PHRASES.cancel,
]);

const COMMAND_BY_ID: ReadonlyMap<string, VoiceCommand> = new Map(
  VOICE_COMMANDS.map((entry) => [entry.id, entry]),
);

export type VoiceDictation = Readonly<{
  command: VoiceCommand;
  capture: Readonly<Required<Pick<VoiceWriteCapture, "title">> & VoiceWriteCapture>;
}>;

/** Unicode control, format (incl. bidi), line/paragraph separator, private-use and surrogate characters. */
const UNSAFE_CHARACTERS = /[\p{Cc}\p{Cf}\p{Zl}\p{Zp}\p{Co}\p{Cs}]/u;
/** Embedded control words: the dictated text is data and may never carry confirm/cancel. */
const EMBEDDED_CONTROL = /\b(?:confirm|confirmed|cancel|cancelled|canceled)\b/;
/** Negated or declarative wording is not a request to add a task. */
const NEGATION =
  /(?:^|[^\p{L}\p{N}'’])(?:not|never|nothing|cannot|no longer|(?:do|does|did|can|could|would|should|will|is|are|was|were|have|has|had)n['’]?t|don['’]?t|won['’]?t|can['’]?t)(?![\p{L}\p{N}])/u;
const DECLARATIVE =
  /^(?:i|we|he|she|they|it|you|i['’]?ve|we['’]?ve|i['’]?m|we['’]?re)\s|\b(?:already|(?:is|was|been|got) (?:done|finished|completed|sent|ordered))\b/;
/**
 * A conjunction that chains a second action onto the title. Bounded safety rule,
 * not an NLP classifier: a conjunction or separator followed directly by a verb
 * from a closed list of common action verbs (outbound/destructive, commerce,
 * contact, scheduling and creation) rejects the title. Anything else, such as a
 * noun conjunction ("buy oil and grease"), is left alone. Unlisted verbs are not
 * detected; a title is still only ever a read-back, confirmed task/reminder text.
 */
const COMPOUND_ACTION =
  /(?:\band|\bthen|\balso|\bplus|\bbut|\bor|\bafterwards?|\bafter that|[;|&])\s*(?:then\s+|also\s+|please\s+)?(?:send|resend|email|e-mail|mail|forward|submit|post|publish|share|text|message|dm|pay|wire|transfer|delete|remove|erase|wipe|approve|execute|run|start|stop|open|close|lock|unlock|turn|switch|activate|deactivate|shut|fire|launch|actuate|move|drive|nolan|jarvis|confirm|cancel|call|phone|ring|order|reorder|book|reserve|schedule|create|make|add|buy|purchase|hire|arrange|organi[sz]e|set up|sign|install|download|upload|apply|register|subscribe|ship|deliver|invite|notify|tell|ask|reply|respond|update|edit|change|reset|restart|reboot|enable|disable|cut|burn|unplug|power|raise|lower|dial|ping)\b/;

/** True when the raw (pre-normalisation) text carries a forbidden control/format character. */
export function hasUnsafeVoiceCharacters(raw: string): boolean {
  return UNSAFE_CHARACTERS.test(raw.trim());
}

function cleanTitle(raw: string): string | undefined {
  if (UNSAFE_CHARACTERS.test(raw)) return undefined;
  const title = raw
    .replace(/^[\s:,;.-]+/, "")
    .replace(/[\s:,;.-]+$/, "")
    .replace(/\s+/g, " ")
    .trim();
  if (title.length < 1 || title.length > MAX_TITLE_LENGTH) return undefined;
  if (!/[\p{L}\p{N}]/u.test(title)) return undefined;
  if (WAKE_TOKEN.test(title)) return undefined;
  if (CONTROL_PHRASES.has(title)) return undefined;
  if (EMBEDDED_CONTROL.test(title)) return undefined;
  if (NEGATION.test(title) || DECLARATIVE.test(title)) return undefined;
  if (COMPOUND_ACTION.test(title)) return undefined;
  return title.charAt(0).toUpperCase() + title.slice(1);
}

/**
 * `none` — not a dictation at all (never reached the grammar).
 * `rejected` — it matched a dictation prefix but the text is unsafe/invalid. The
 * session must fail closed on this and must not fall through to inference.
 */
export type VoiceDictationClassification =
  | Readonly<{ status: "none" }>
  | Readonly<{ status: "rejected" }>
  | Readonly<{ status: "captured"; dictation: VoiceDictation }>;

const NONE: VoiceDictationClassification = Object.freeze({ status: "none" });
const REJECTED: VoiceDictationClassification = Object.freeze({ status: "rejected" });

export function classifyVoiceDictation(
  transcript: string,
  profile: VoiceProfile,
): VoiceDictationClassification {
  if (profile !== "client") return NONE;
  const text = normalizeUtterance(transcript);
  if (text.length === 0) return NONE;
  // Whitespace normalisation would turn an embedded newline, tab or CR into a
  // plain space, so the unsafe check must see the original text.
  const rawUnsafe = hasUnsafeVoiceCharacters(transcript);

  const task = TASK_PATTERN.exec(text);
  if (task) {
    if (rawUnsafe) return REJECTED;
    const command = COMMAND_BY_ID.get(TASK_COMMAND_ID);
    if (!command) return REJECTED;
    const categoryWord = task[1];
    let category: VoiceTaskCategory = DEFAULT_VOICE_TASK_CATEGORY;
    if (categoryWord !== undefined && !CATEGORY_FILLERS.has(categoryWord)) {
      const mapped = CATEGORY_ALIASES.get(categoryWord);
      // An unknown word before "task" is not guessed into a category.
      if (!mapped) return REJECTED;
      category = mapped;
    }
    const title = cleanTitle(task[2] ?? "");
    if (!title) return REJECTED;
    return {
      status: "captured",
      dictation: { command, capture: Object.freeze({ title, category }) },
    };
  }

  const reminder = REMINDER_PATTERN.exec(text);
  if (reminder) {
    if (rawUnsafe) return REJECTED;
    const command = COMMAND_BY_ID.get(REMINDER_COMMAND_ID);
    if (!command) return REJECTED;
    const title = cleanTitle(reminder[1] ?? "");
    if (!title) return REJECTED;
    return {
      status: "captured",
      dictation: { command, capture: Object.freeze({ title }) },
    };
  }

  return NONE;
}

/**
 * Parse a wake-stripped final utterance into a safe-write capture, or return
 * `undefined` (fail closed) when it is not an unambiguous dictation.
 */
export function parseVoiceDictation(
  transcript: string,
  profile: VoiceProfile,
): VoiceDictation | undefined {
  const result = classifyVoiceDictation(transcript, profile);
  return result.status === "captured" ? result.dictation : undefined;
}

/** Stable comparison key: command plus canonical capture fields. */
export function voiceDictationKey(dictation: VoiceDictation): string {
  return JSON.stringify([
    dictation.command.id,
    dictation.capture.title.toLowerCase(),
    dictation.capture.category ?? null,
  ]);
}

/** One-line read-back the HUD shows and speaks before anything is staged. */
export function describeVoiceDictation(
  dictation: Pick<VoiceDictation, "command" | "capture">,
): string {
  const { command, capture } = dictation;
  if (command.id === TASK_COMMAND_ID) {
    return `Add task “${capture.title}” (${capture.category ?? DEFAULT_VOICE_TASK_CATEGORY})`;
  }
  return `Add reminder “${capture.title}”`;
}
