/**
 * NOLAN voice — spoken capture for safe writes (#567, #811).
 *
 * The guarded catalog matches whole utterances exactly, so "Nolan, add a task:
 * order bar oil" used to lose everything after "add a task" and could never
 * stage anything. This module adds a deliberately narrow, deterministic
 * dictation grammar for the three safe writes that have ToolAction executors
 * (`tasks:create`, `reminders:create`, `errands:create`) and nothing else.
 *
 * Safety contract:
 *   - Pure and side-effect free. It returns a capture proposal only.
 *   - Only the client profile's safe-write commands can be dictated. Queries,
 *     actuation and quote send/draft are never reachable.
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
import {
  describeSpokenReminderDue,
  parseSpokenDuePhrase,
  splitSpokenReminderDue,
  type SpokenDueContext,
} from "./voiceReminderDue.js";
import type { VoiceWriteCapture } from "./voiceSafeWrite.js";

/** Task categories the HUD capture form offers. */
export const VOICE_TASK_CATEGORIES = ["personal", "work", "builds", "money", "life"] as const;
export type VoiceTaskCategory = (typeof VOICE_TASK_CATEGORIES)[number];

/** Same default as the HUD capture form's first option; always read back before staging. */
export const DEFAULT_VOICE_TASK_CATEGORY: VoiceTaskCategory = "personal";

const MAX_TITLE_LENGTH = 200;

const TASK_COMMAND_ID = "client.capture-task";
const REMINDER_COMMAND_ID = "client.follow-up-reminder";
const ERRAND_COMMAND_ID = "client.capture-errand";
export const COMPLETE_TASK_COMMAND_ID = "client.complete-task";
export const COMPLETE_ERRAND_COMMAND_ID = "client.complete-errand";
/** A completion whose kind was not spoken; it is never armed until resolved. */
export const COMPLETE_ITEM_COMMAND_ID = "client.complete-item";
export const CANCEL_REMINDER_COMMAND_ID = "client.cancel-reminder";
export const REMOVE_ERRAND_COMMAND_ID = "client.remove-errand";
export const RESCHEDULE_REMINDER_COMMAND_ID = "client.reschedule-reminder";

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
  /^(?:(?:add|capture|create|make|put)(?: (?:a|an|another|me a))?|new) (?:([a-z]+) )?task(?: (?:to|for|called|saying|that says))?[\s:,-]+(.+)$/d;

/** "remind me to X", "add a reminder to X", "set a reminder to X", "reminder to X". */
const REMINDER_PATTERN =
  /^(?:remind me to|(?:add|set|make|create) (?:a |me a )?reminder to|reminder to|new reminder to)[\s:,-]+(.+)$/d;

function completionCommand(
  id: string,
  summary: string,
  proposes?: Readonly<{ tool: string; operation: string }>,
): VoiceCommand {
  return Object.freeze({
    id,
    profile: "client" as const,
    phrases: Object.freeze([]) as readonly string[],
    kind: "propose" as const,
    criticality: "routine" as const,
    requiresSpokenConfirmation: false,
    summary,
    ...(proposes ? { proposes: Object.freeze({ ...proposes }) } : {}),
  });
}

/**
 * Completion commands. They are not catalog phrases (the archived catalog is
 * pinned); like every dictation they are read back with the resolved item's
 * full title and only staged after a spoken confirmation.
 */
export const COMPLETE_TASK_COMMAND = completionCommand(
  COMPLETE_TASK_COMMAND_ID,
  "Stage completing one voice-captured task. Voice does not approve or execute it.",
  { tool: "tasks", operation: "complete" },
);
export const COMPLETE_ERRAND_COMMAND = completionCommand(
  COMPLETE_ERRAND_COMMAND_ID,
  "Stage marking one open errand done. Voice does not approve or execute it.",
  { tool: "errands", operation: "complete" },
);
/** Has no governed operation of its own: it must resolve to a task or an errand. */
export const COMPLETE_ITEM_COMMAND = completionCommand(
  COMPLETE_ITEM_COMMAND_ID,
  "Find one open task or errand to mark done.",
);

/** Cancelling one existing reminder, resolved like a completion before anything is read back. */
export const CANCEL_REMINDER_COMMAND = completionCommand(
  CANCEL_REMINDER_COMMAND_ID,
  "Stage cancelling one voice-captured reminder. Voice does not approve or execute it.",
  { tool: "reminders", operation: "cancel" },
);

/** Removing one open errand from the list, resolved like a completion. */
export const REMOVE_ERRAND_COMMAND = completionCommand(
  REMOVE_ERRAND_COMMAND_ID,
  "Stage removing one open errand from the list. Voice does not approve or execute it.",
  { tool: "errands", operation: "remove" },
);

/** Moving one existing reminder to a new due value (AM-017), resolved like a completion. */
export const RESCHEDULE_REMINDER_COMMAND = completionCommand(
  RESCHEDULE_REMINDER_COMMAND_ID,
  "Stage moving one voice-captured reminder to a new due time. Voice does not approve or execute it.",
  { tool: "reminders", operation: "reschedule" },
);

export type VoiceCompletionKind = "task" | "errand" | "any" | "reminder";

/** The kind a completion command searches, or undefined for any other command. */
export function voiceCompletionKind(command: VoiceCommand): VoiceCompletionKind | undefined {
  if (command.id === COMPLETE_TASK_COMMAND_ID) return "task";
  if (command.id === COMPLETE_ERRAND_COMMAND_ID) return "errand";
  if (command.id === COMPLETE_ITEM_COMMAND_ID) return "any";
  if (command.id === CANCEL_REMINDER_COMMAND_ID) return "reminder";
  if (command.id === REMOVE_ERRAND_COMMAND_ID) return "errand";
  if (command.id === RESCHEDULE_REMINDER_COMMAND_ID) return "reminder";
  return undefined;
}

/** "add an errand: X", "new errand, X", "add an errand to pick up X". Group 1 is the title. */
const ERRAND_PATTERN =
  /^(?:(?:add|capture|create|make|put)(?: (?:a|an|another|me an?))?|new) errand(?: (?:to|for|called|saying))?[\s:,-]+(.+)$/d;

/** "add X to the errands", "put X on my shopping list". Group 1 is the title. */
const ERRAND_LIST_PATTERN =
  /^(?:add|put) (.+?) (?:on|to) (?:the |my )?(?:errands|errand list|errands list|shopping list)$/d;

/**
 * Completing an existing item: "mark bar oil as done", "tick off the errand
 * milk", "complete the task order bar oil". Group 1 is an optional kind word
 * (task/errand); group 2 is the spoken reference, which the session resolves
 * against the authoritative records before anything is read back.
 */
const COMPLETE_MARK_PATTERN =
  /^(?:mark|set) (?:the |my )?(?:(task|errand) )?(.+?) (?:as )?(?:done|complete|completed|finished)$/d;
const COMPLETE_TICK_PATTERN = /^(?:tick|cross|check) off (?:the |my )?(?:(task|errand) )?(.+)$/d;
const COMPLETE_VERB_PATTERN = /^(?:complete|finish) (?:the |my )?(task|errand)[\s:,-]+(.+)$/d;

/**
 * Cancelling an existing reminder: "cancel the reminder to order bar oil",
 * "delete my reminder: call Dave", "cancel the bar oil reminder". Group 1 is
 * the spoken reference, resolved against the authoritative reminders.
 */
const CANCEL_REMINDER_LEADING_PATTERN =
  /^(?:cancel|delete|remove|scrap|drop|clear) (?:the |my )?reminder(?: (?:to|for|about|called|saying))?[\s:,-]+(?:(?:the|my) )?(.+)$/d;
const CANCEL_REMINDER_TRAILING_PATTERN =
  /^(?:cancel|delete|remove|scrap|drop|clear) (?:the |my )?(.+?) reminder$/d;

/**
 * Removing an errand from the list: "take milk off the errands", "remove the
 * screws from my shopping list", "delete the errand milk". Group 1 is the
 * spoken reference, resolved against the open errands.
 */
const ERRAND_LIST_NAME = "(?:the |my )?(?:errands|errand list|errands list|shopping list)";
const REMOVE_ERRAND_FROM_PATTERN = new RegExp(
  `^(?:remove|delete|drop|scrap) (?:(?:the|my) )?(.+?) (?:from|off) ${ERRAND_LIST_NAME}$`,
  "d",
);
const REMOVE_ERRAND_OFF_PATTERN = new RegExp(
  `^(?:take|knock|strike) (?:(?:the|my) )?(.+?) off ${ERRAND_LIST_NAME}$`,
  "d",
);
const REMOVE_ERRAND_LEADING_PATTERN =
  /^(?:remove|delete|drop|scrap) (?:the |my )?errand[\s:,-]+(?:(?:the|my) )?(.+)$/d;

/**
 * Rescheduling a reminder: "move the bar oil reminder to friday at 9 am",
 * "push my reminder to call dave to tomorrow", "reschedule the rego reminder
 * for 3 pm". Group 1 is the spoken reference; group 2 must be nothing but a
 * due phrase. In the leading form the last "to/until" splits the two, so a
 * reference may itself contain "to" ("call Dave to book the trailer").
 */
const RESCHEDULE_VERB = "(?:move|push|reschedule|shift|change|bump)";
const RESCHEDULE_TRAILING_PATTERN = new RegExp(
  `^${RESCHEDULE_VERB} (?:the |my )?(.+?) reminder (?:to|until|till|for) (.+)$`,
  "d",
);
const RESCHEDULE_LEADING_PATTERN = new RegExp(
  `^${RESCHEDULE_VERB} (?:the |my )?reminder (?:to|for|about|called) (?:(?:the|my) )?(.+) (?:to|until|till) (.+)$`,
  "d",
);

/** A reference that names no item ("mark it done", "tick off the task"). */
const VAGUE_REFERENCES: ReadonlySet<string> = new Set([
  "the",
  "my",
  "a",
  "an",
  "it",
  "that",
  "this",
  "them",
  "those",
  "these",
  "one",
  "task",
  "tasks",
  "errand",
  "errands",
  "reminder",
  "reminders",
  "everything",
  "all",
  "all of them",
  "the lot",
]);

/** "remind me tomorrow at 7 am to X": a due phrase before the title. */
const REMINDER_DUE_FIRST_PATTERN = /^remind me[\s,]+(?!to\b)(.+)$/d;

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

/**
 * The dictated errand command. The archived catalog entry for "add an errand"
 * predates the executor and still only names `create_errand`, so the bare
 * phrase stays unstaged. A dictated errand (one that carries its title) is the
 * same command bound to the governed `errands:create` executor; like every
 * dictation it is read back and only staged after a spoken confirmation.
 */
const ERRAND_DICTATION_COMMAND: VoiceCommand | undefined = (() => {
  const catalog = COMMAND_BY_ID.get(ERRAND_COMMAND_ID);
  if (!catalog) return undefined;
  return Object.freeze({
    ...catalog,
    summary:
      "Stage an errand on the existing ToolAction path. Voice does not approve or execute it.",
    proposes: Object.freeze({ tool: "errands", operation: "create" }),
  });
})();

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

/**
 * `normalizeUtterance` without lower-casing, for dictated text whose casing is
 * data ("call Dave about the BMW"). Matching must still use `normalizeUtterance`.
 * Returns `undefined` when lower-casing would change the string's length (a few
 * Unicode letters do), so a caller can never slice the two forms out of step.
 */
export function normalizeUtterancePreservingCase(raw: string): string | undefined {
  const cased = raw
    .trim()
    .replace(/\s+/g, " ")
    .replace(/^[\s.,!?;:]+/, "")
    .replace(/[\s.,!?;:]+$/, "");
  return cased.toLowerCase() === normalizeUtterance(raw) ? cased : undefined;
}

/** True when the raw (pre-normalisation) text carries a forbidden control/format character. */
export function hasUnsafeVoiceCharacters(raw: string): boolean {
  return UNSAFE_CHARACTERS.test(raw.trim());
}

function tidy(raw: string): string {
  return raw
    .replace(/^[\s:,;.-]+/, "")
    .replace(/[\s:,;.-]+$/, "")
    .replace(/\s+/g, " ")
    .trim();
}

/**
 * Validate a dictated title on its lower-cased form (every safety rule is
 * case-insensitive) and return it with the speaker's casing. `cased` is the
 * same span of the case-preserving transcript; it is used only when it lines
 * up exactly with the lower-cased text, otherwise the lower-cased form is used.
 */
function cleanTitle(raw: string, cased?: string): string | undefined {
  if (UNSAFE_CHARACTERS.test(raw)) return undefined;
  const title = tidy(raw);
  if (title.length < 1 || title.length > MAX_TITLE_LENGTH) return undefined;
  if (!/[\p{L}\p{N}]/u.test(title)) return undefined;
  if (WAKE_TOKEN.test(title)) return undefined;
  if (CONTROL_PHRASES.has(title)) return undefined;
  if (EMBEDDED_CONTROL.test(title)) return undefined;
  if (NEGATION.test(title) || DECLARATIVE.test(title)) return undefined;
  if (COMPOUND_ACTION.test(title)) return undefined;
  const casedTitle = cased === undefined ? undefined : tidy(cased);
  const display =
    casedTitle !== undefined && casedTitle.toLowerCase() === title ? casedTitle : title;
  // Capitalise a lower-case first word ("call Dave" -> "Call Dave"), but never
  // rewrite one the speaker cased deliberately ("iPhone", "eBay").
  const firstWord = display.split(" ", 1)[0] ?? "";
  if (firstWord !== firstWord.toLowerCase()) return display;
  return display.charAt(0).toUpperCase() + display.slice(1);
}

/** The span of `cased` that group `group` of a `d`-flag match on the lower-cased text covers. */
function casedGroup(
  match: RegExpExecArray,
  group: number,
  cased: string | undefined,
): string | undefined {
  const span = match.indices?.[group];
  if (cased === undefined || !span) return undefined;
  return cased.slice(span[0], span[1]);
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
  /** Owner clock and timezone. Without it a spoken due time stays in the title. */
  due?: SpokenDueContext,
): VoiceDictationClassification {
  if (profile !== "client") return NONE;
  const text = normalizeUtterance(transcript);
  if (text.length === 0) return NONE;
  const cased = normalizeUtterancePreservingCase(transcript);
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
    const title = cleanTitle(task[2] ?? "", casedGroup(task, 2, cased));
    if (!title) return REJECTED;
    return {
      status: "captured",
      dictation: { command, capture: Object.freeze({ title, category }) },
    };
  }

  const reschedule =
    RESCHEDULE_LEADING_PATTERN.exec(text) ?? RESCHEDULE_TRAILING_PATTERN.exec(text);
  if (reschedule) {
    if (rawUnsafe) return REJECTED;
    // Without the owner's clock and timezone a new time cannot be resolved.
    if (!due) return REJECTED;
    const reference = cleanTitle(reschedule[1] ?? "", casedGroup(reschedule, 1, cased));
    if (!reference || VAGUE_REFERENCES.has(reference.toLowerCase())) return REJECTED;
    const newDue = parseSpokenDuePhrase(reschedule[2] ?? "", due);
    if (newDue === "none" || newDue === "rejected") return REJECTED;
    return {
      status: "captured",
      dictation: {
        command: RESCHEDULE_REMINDER_COMMAND,
        capture: Object.freeze({
          title: reference,
          dueRaw: newDue.dueRaw,
          ...(newDue.dueAt === undefined
            ? {}
            : { dueAt: newDue.dueAt, dueTimezone: newDue.dueTimezone }),
        }),
      },
    };
  }

  const cancel =
    CANCEL_REMINDER_LEADING_PATTERN.exec(text) ?? CANCEL_REMINDER_TRAILING_PATTERN.exec(text);
  if (cancel) {
    if (rawUnsafe) return REJECTED;
    const reference = cleanTitle(cancel[1] ?? "", casedGroup(cancel, 1, cased));
    if (!reference || VAGUE_REFERENCES.has(reference.toLowerCase())) return REJECTED;
    return {
      status: "captured",
      dictation: { command: CANCEL_REMINDER_COMMAND, capture: Object.freeze({ title: reference }) },
    };
  }

  const removal =
    REMOVE_ERRAND_FROM_PATTERN.exec(text) ??
    REMOVE_ERRAND_OFF_PATTERN.exec(text) ??
    REMOVE_ERRAND_LEADING_PATTERN.exec(text);
  if (removal) {
    if (rawUnsafe) return REJECTED;
    const reference = cleanTitle(removal[1] ?? "", casedGroup(removal, 1, cased));
    if (!reference || VAGUE_REFERENCES.has(reference.toLowerCase())) return REJECTED;
    return {
      status: "captured",
      dictation: { command: REMOVE_ERRAND_COMMAND, capture: Object.freeze({ title: reference }) },
    };
  }

  const reminder = REMINDER_PATTERN.exec(text);
  const dueFirst = reminder || !due ? null : REMINDER_DUE_FIRST_PATTERN.exec(text);
  if (reminder || dueFirst) {
    if (rawUnsafe) return REJECTED;
    const command = COMMAND_BY_ID.get(REMINDER_COMMAND_ID);
    if (!command) return REJECTED;
    const bodyMatch = (reminder ?? dueFirst) as RegExpExecArray;
    let body = bodyMatch[1] ?? "";
    let casedBody = casedGroup(bodyMatch, 1, cased);
    let spoken: VoiceWriteCapture = {};
    if (due) {
      const split = splitSpokenReminderDue(body, due, reminder ? "suffix" : "prefix");
      if (split.status === "rejected") return REJECTED;
      // "remind me <something>" with no leading due phrase is not a dictation.
      if (split.status === "none" && !reminder) return NONE;
      if (split.status === "due") {
        // The title is the leading span of the body for "… tomorrow at 7 am"
        // and the trailing span for "tomorrow at 7 am to …".
        if (casedBody !== undefined) {
          casedBody = reminder
            ? casedBody.slice(0, split.title.length)
            : casedBody.slice(casedBody.length - split.title.length);
        }
        body = split.title;
        spoken = {
          dueRaw: split.due.dueRaw,
          ...(split.due.dueAt === undefined
            ? {}
            : { dueAt: split.due.dueAt, dueTimezone: split.due.dueTimezone }),
        };
      }
    }
    const title = cleanTitle(body, casedBody);
    if (!title) return REJECTED;
    return {
      status: "captured",
      dictation: { command, capture: Object.freeze({ title, ...spoken }) },
    };
  }

  const completion =
    COMPLETE_MARK_PATTERN.exec(text) ??
    COMPLETE_TICK_PATTERN.exec(text) ??
    COMPLETE_VERB_PATTERN.exec(text);
  if (completion) {
    if (rawUnsafe) return REJECTED;
    const reference = cleanTitle(completion[2] ?? "", casedGroup(completion, 2, cased));
    if (!reference || VAGUE_REFERENCES.has(reference.toLowerCase())) return REJECTED;
    const command =
      completion[1] === "task"
        ? COMPLETE_TASK_COMMAND
        : completion[1] === "errand"
          ? COMPLETE_ERRAND_COMMAND
          : COMPLETE_ITEM_COMMAND;
    return {
      status: "captured",
      dictation: { command, capture: Object.freeze({ title: reference }) },
    };
  }

  const errand = ERRAND_PATTERN.exec(text) ?? ERRAND_LIST_PATTERN.exec(text);
  if (errand) {
    if (rawUnsafe) return REJECTED;
    if (!ERRAND_DICTATION_COMMAND) return REJECTED;
    const title = cleanTitle(errand[1] ?? "", casedGroup(errand, 1, cased));
    if (!title) return REJECTED;
    return {
      status: "captured",
      dictation: { command: ERRAND_DICTATION_COMMAND, capture: Object.freeze({ title }) },
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
  due?: SpokenDueContext,
): VoiceDictation | undefined {
  const result = classifyVoiceDictation(transcript, profile, due);
  return result.status === "captured" ? result.dictation : undefined;
}

/** Stable comparison key: command plus canonical capture fields. */
export function voiceDictationKey(dictation: VoiceDictation): string {
  return JSON.stringify([
    dictation.command.id,
    dictation.capture.title.toLowerCase(),
    dictation.capture.category ?? null,
    dictation.capture.dueRaw ?? null,
    dictation.capture.dueAt ?? null,
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
  if (command.id === ERRAND_COMMAND_ID) return `Add errand “${capture.title}”`;
  if (command.id === COMPLETE_TASK_COMMAND_ID) return `Mark task “${capture.title}” done`;
  if (command.id === COMPLETE_ERRAND_COMMAND_ID) return `Mark errand “${capture.title}” done`;
  if (command.id === COMPLETE_ITEM_COMMAND_ID) return `Mark “${capture.title}” done`;
  if (command.id === CANCEL_REMINDER_COMMAND_ID) return `Cancel reminder “${capture.title}”`;
  if (command.id === RESCHEDULE_REMINDER_COMMAND_ID && capture.dueRaw !== undefined) {
    const when = describeSpokenReminderDue({
      dueRaw: capture.dueRaw,
      ...(capture.dueAt === undefined || capture.dueTimezone === undefined
        ? {}
        : { dueAt: capture.dueAt, dueTimezone: capture.dueTimezone }),
    });
    return `Reschedule reminder “${capture.title}” due ${when}`;
  }
  if (command.id === REMOVE_ERRAND_COMMAND_ID) {
    return `Remove errand “${capture.title}” from the list`;
  }
  if (capture.dueRaw === undefined) return `Add reminder “${capture.title}”`;
  const due = describeSpokenReminderDue({
    dueRaw: capture.dueRaw,
    ...(capture.dueAt === undefined || capture.dueTimezone === undefined
      ? {}
      : { dueAt: capture.dueAt, dueTimezone: capture.dueTimezone }),
  });
  return `Add reminder “${capture.title}” due ${due}`;
}
