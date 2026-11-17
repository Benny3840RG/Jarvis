/**
 * NOLAN voice — spoken due times for dictated reminders.
 *
 * "Nolan, remind me to call Dave tomorrow at 7 am" used to store the whole
 * phrase as an undated title. This module splits a bounded spoken due phrase
 * off a dictated reminder and resolves it with the existing reminder parser
 * (`parseReminderDue`), so the read-back shows the exact time that would be
 * stored and the confirmed ToolAction carries `dueRaw`/`dueAt`/`dueTimezone`.
 *
 * Deliberately narrow and fail-closed:
 *   - Days: today, tomorrow, tonight, a weekday ("friday", "on friday",
 *     "this friday", "by friday"). "next friday" is ambiguous and is never resolved.
 *   - Times: "7 am", "7am", "7 a.m.", "7:30 pm", "19:00", "noon", "midday".
 *     A bare 1-12 hour with no am/pm ("at 7") is ambiguous: it stays in the
 *     preserved due text but no timestamp is guessed. After "tonight" a bare
 *     1-11 is pm; "tonight at 12" (noon or midnight?) is never guessed.
 *   - A time with no day means the next occurrence (today if still ahead).
 *   - A day with no time is preserved as due text only; no time is invented.
 *   - A resolved time in the past ("today at 7 am" at noon) or a contradiction
 *     ("tonight at 7 am") rejects the dictation rather than storing nonsense.
 *   - Pure: the caller supplies `now` and the owner's timezone.
 */

import { parseReminderDue } from "../reminders/due.js";

export type SpokenReminderDue = Readonly<{
  dueRaw: string;
  dueAt?: number;
  dueTimezone?: string;
}>;

export type SpokenReminderSplit =
  | Readonly<{ status: "none" }>
  | Readonly<{ status: "rejected" }>
  | Readonly<{ status: "due"; title: string; due: SpokenReminderDue }>;

export type SpokenDueContext = Readonly<{ now: number; timezone: string }>;

const WEEKDAY = "monday|tuesday|wednesday|thursday|friday|saturday|sunday";
const DAY = `(?:by )?(?:today|tomorrow|tonight)|(?:(?:on|this|by) )?(?:${WEEKDAY})`;
const MERIDIEM = "a\\.? ?m\\.?|p\\.? ?m\\.?";
const TIME = `noon|midday|\\d{1,2}(?::\\d{2})?(?: ?(?:${MERIDIEM}))?`;
const CONNECTOR = "(?:at|by|around)";

/** "<title> <day>[ at <time>]" or "<title> at <time>[ <day>]". */
const SUFFIX_DAY_FIRST = new RegExp(`^(.+?) (${DAY})(?: ${CONNECTOR} (${TIME}))?$`);
const SUFFIX_TIME_FIRST = new RegExp(`^(.+?) ${CONNECTOR} (${TIME})(?: (${DAY}))?$`);
/** "<day>[ at <time>] to <title>" or "at <time>[ <day>] to <title>" (after "remind me"). */
const PREFIX_DAY_FIRST = new RegExp(`^(${DAY})(?: ${CONNECTOR} (${TIME}))? to (.+)$`);
const PREFIX_TIME_FIRST = new RegExp(`^${CONNECTOR} (${TIME})(?: (${DAY}))? to (.+)$`);

const NEXT_WEEKDAY = new RegExp(`\\bnext (?:${WEEKDAY}|week)\\b`);

type ClockTime = { hour: number; minute: number; ambiguous: boolean };

function parseSpokenTime(spoken: string): ClockTime | undefined {
  if (spoken === "noon" || spoken === "midday") return { hour: 12, minute: 0, ambiguous: false };
  const match = /^(\d{1,2})(?::(\d{2}))?(?: ?([ap])\.? ?m\.?)?$/.exec(spoken);
  if (!match) return undefined;
  let hour = Number(match[1]);
  const minute = match[2] === undefined ? 0 : Number(match[2]);
  const meridiem = match[3];
  if (minute > 59) return undefined;
  if (meridiem !== undefined) {
    if (hour < 1 || hour > 12) return undefined;
    if (meridiem === "a") hour = hour === 12 ? 0 : hour;
    else hour = hour === 12 ? 12 : hour + 12;
    return { hour, minute, ambiguous: false };
  }
  if (hour > 23) return undefined;
  // "at 7" or "at 7:30" could be morning or evening; "at 19:00" or "at 0:30" cannot.
  return { hour, minute, ambiguous: hour >= 1 && hour <= 12 };
}

function hhmm(time: { hour: number; minute: number }): string {
  return `${String(time.hour).padStart(2, "0")}:${String(time.minute).padStart(2, "0")}`;
}

function dayWord(day: string): string {
  return day.replace(/^(?:on|this|by) /, "");
}

function resolve(
  dayRaw: string | undefined,
  timeRaw: string | undefined,
  context: SpokenDueContext,
): SpokenReminderDue | "rejected" {
  const dueRaw = [dayRaw, timeRaw === undefined ? undefined : `at ${timeRaw}`]
    .filter((part): part is string => part !== undefined)
    .join(" ");
  const day = dayRaw === undefined ? undefined : dayWord(dayRaw);
  const tonight = day === "tonight";
  let time = timeRaw === undefined ? undefined : parseSpokenTime(timeRaw);
  if (timeRaw !== undefined && time === undefined) return "rejected";

  if (tonight && time) {
    if (time.ambiguous) {
      // "tonight at 12" could mean midnight (tomorrow 00:00) or be a slip for
      // noon; neither is guessed. A bare 1-11 after "tonight" is the evening.
      if (time.hour === 12) return { dueRaw };
      time = { hour: time.hour + 12, minute: time.minute, ambiguous: false };
    } else if (time.hour <= 12) {
      // "tonight at 7 am", "tonight at 12 pm" (noon) and "tonight at 12 am"
      // contradict "tonight"; the evening is 13:00 onwards.
      return "rejected";
    }
  }
  // No time, or an hour that could be am or pm: keep what was said, guess nothing.
  if (!time || time.ambiguous) return { dueRaw };

  const options = { timezone: context.timezone, now: new Date(context.now) };
  const parserDay = day === undefined || tonight ? "today" : day;
  let parsed = parseReminderDue(`${parserDay} ${hhmm(time)}`, options);
  if (day === undefined && parsed.at !== undefined && parsed.at <= context.now) {
    parsed = parseReminderDue(`tomorrow ${hhmm(time)}`, options);
  }
  if (parsed.at === undefined || parsed.timezone === undefined) return "rejected";
  if (parsed.at <= context.now) return "rejected";
  return { dueRaw, dueAt: parsed.at, dueTimezone: parsed.timezone };
}

/**
 * Split a spoken due phrase off a normalised reminder body: a trailing phrase
 * for "remind me to call dave tomorrow at 7 am" (`suffix`), or a leading one
 * for "remind me tomorrow at 7 am to call dave" (`prefix`, the text after
 * "remind me"). `none` means no due phrase was found.
 */
export function splitSpokenReminderDue(
  body: string,
  context: SpokenDueContext,
  form: "suffix" | "prefix" = "suffix",
): SpokenReminderSplit {
  if (NEXT_WEEKDAY.test(body)) return { status: "none" };

  let title: string | undefined;
  let day: string | undefined;
  let time: string | undefined;
  if (form === "prefix") {
    const prefixDay = PREFIX_DAY_FIRST.exec(body);
    const prefixTime = prefixDay ? null : PREFIX_TIME_FIRST.exec(body);
    if (prefixDay) [, day, time, title] = prefixDay;
    else if (prefixTime) [, time, day, title] = prefixTime;
    else return { status: "none" };
  } else {
    // Both suffix orders can match ("call dave at 7 am tomorrow"); the one that
    // consumes more of the tail as due text leaves the shorter, correct title.
    const timeFirst = SUFFIX_TIME_FIRST.exec(body);
    const dayFirst = SUFFIX_DAY_FIRST.exec(body);
    const pick =
      timeFirst && dayFirst
        ? (timeFirst[1] ?? "").length <= (dayFirst[1] ?? "").length
          ? "time"
          : "day"
        : timeFirst
          ? "time"
          : dayFirst
            ? "day"
            : undefined;
    if (pick === "time" && timeFirst) [, title, time, day] = timeFirst;
    else if (pick === "day" && dayFirst) [, title, day, time] = dayFirst;
    else return { status: "none" };
  }

  if (!title || title.trim().length === 0) return { status: "rejected" };
  const due = resolve(day, time, context);
  if (due === "rejected") return { status: "rejected" };
  return { status: "due", title, due };
}

/**
 * Parse a phrase that must be nothing but a due value ("friday at 9 am",
 * "tomorrow", "3:30 pm"), as when rescheduling an existing reminder. It uses
 * the same bounded grammar and fail-closed resolution as a dictated
 * reminder's trailing due phrase; anything left over is `none`.
 */
export function parseSpokenDuePhrase(
  phrase: string,
  context: SpokenDueContext,
): SpokenReminderDue | "rejected" | "none" {
  const text = phrase.trim();
  if (text.length === 0) return "none";
  // A sentinel title lets the suffix grammar match; it must consume the rest.
  for (const body of [`x ${text}`, `x at ${text}`]) {
    const split = splitSpokenReminderDue(body, context, "suffix");
    if (split.status === "rejected") return "rejected";
    if (split.status === "due" && split.title === "x") return split.due;
  }
  return "none";
}

/** Human read-back of a resolved due value, in the owner's timezone. */
export function describeSpokenReminderDue(due: SpokenReminderDue): string {
  if (due.dueAt === undefined || due.dueTimezone === undefined) {
    return /\d/.test(due.dueRaw)
      ? `“${due.dueRaw}” (no time set — say am or pm)`
      : `“${due.dueRaw}” (no time set)`;
  }
  return new Intl.DateTimeFormat("en-AU", {
    timeZone: due.dueTimezone,
    weekday: "short",
    day: "numeric",
    month: "short",
    hour: "numeric",
    minute: "2-digit",
    hour12: true,
  }).format(new Date(due.dueAt));
}
