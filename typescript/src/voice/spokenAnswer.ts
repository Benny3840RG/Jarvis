/**
 * NOLAN voice — wording helpers for spoken answers.
 *
 * Every fact still comes from the authoritative read; these only shape how it
 * sounds ("You've got two tasks: Call Claire and order bar oil.") instead of
 * reading out a record count ("2 open tasks. Call Claire; Order bar oil.").
 */

const SMALL_NUMBERS = [
  "no",
  "one",
  "two",
  "three",
  "four",
  "five",
  "six",
  "seven",
  "eight",
  "nine",
  "ten",
] as const;

/** "one task", "three errands", "12 reminders". */
export function spokenCount(count: number, singular: string, plural = `${singular}s`): string {
  const number = count >= 0 && count < SMALL_NUMBERS.length ? SMALL_NUMBERS[count]! : `${count}`;
  return `${number} ${count === 1 ? singular : plural}`;
}

/** "A", "A and B", "A, B and C", "A, B, C and 4 more". */
export function spokenList(
  names: readonly string[],
  total = names.length,
  conjunction: "and" | "or" = "and",
): string {
  const shown = names.filter((name) => name.trim().length > 0);
  if (shown.length === 0) return "";
  const extra = Math.max(0, total - shown.length);
  const items = extra > 0 ? [...shown, `${extra} more`] : shown;
  if (items.length === 1) return items[0]!;
  return `${items.slice(0, -1).join(", ")} ${conjunction} ${items[items.length - 1]!}`;
}

/** "Lead: A and B." or just "Lead." when there is nothing to name. */
export function withList(lead: string, names: readonly string[], total = names.length): string {
  const list = spokenList(names, total);
  return list ? `${lead}: ${list}.` : `${lead}.`;
}

function dayKey(instant: number, timeZone: string): string {
  return new Intl.DateTimeFormat("en-CA", {
    timeZone,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).format(new Date(instant));
}

/** "9 am", "2:30 pm". */
export function spokenTime(instant: number, timeZone: string): string {
  const parts = new Intl.DateTimeFormat("en-AU", {
    timeZone,
    hour: "numeric",
    minute: "2-digit",
    hour12: true,
  }).formatToParts(new Date(instant));
  const hour = parts.find((part) => part.type === "hour")?.value ?? "";
  const minute = parts.find((part) => part.type === "minute")?.value ?? "00";
  const period = (parts.find((part) => part.type === "dayPeriod")?.value ?? "")
    .toLowerCase()
    .replace(/\./g, "");
  return `${hour}${minute === "00" ? "" : `:${minute}`} ${period}`.trim();
}

/** "today at 3 pm", "tomorrow at 9 am", "Friday at 9 am", "Monday 7 December at 9 am". */
export function spokenWhen(instant: number, now: number, timeZone: string): string {
  const time = spokenTime(instant, timeZone);
  const day = dayKey(instant, timeZone);
  if (day === dayKey(now, timeZone)) return `today at ${time}`;
  if (day === dayKey(now + 86_400_000, timeZone)) return `tomorrow at ${time}`;
  const weekday = new Intl.DateTimeFormat("en-AU", { timeZone, weekday: "long" }).format(
    new Date(instant),
  );
  if (instant > now && instant - now < 6 * 86_400_000) return `${weekday} at ${time}`;
  const date = new Intl.DateTimeFormat("en-AU", {
    timeZone,
    weekday: "long",
    day: "numeric",
    month: "long",
  })
    .format(new Date(instant))
    .replace(",", "");
  return `${date} at ${time}`;
}
