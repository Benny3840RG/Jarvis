export type ReminderDue = {
  raw: string;
  at?: number;
  timezone?: string;
};

type CalendarDateTime = {
  year: number;
  month: number;
  day: number;
  hour: number;
  minute: number;
  second: number;
};

const DAY_MS = 24 * 60 * 60 * 1_000;
const WEEKDAYS = [
  "sunday",
  "monday",
  "tuesday",
  "wednesday",
  "thursday",
  "friday",
  "saturday",
] as const;

function formatter(timezone: string): Intl.DateTimeFormat {
  return new Intl.DateTimeFormat("en-CA", {
    timeZone: timezone,
    calendar: "gregory",
    numberingSystem: "latn",
    hourCycle: "h23",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
  });
}

function isValidFixedOffsetTimezone(timezone: string): boolean {
  if (timezone === "UTC") return true;
  const match = /^UTC([+-])(\d{2}):(\d{2})$/.exec(timezone);
  if (!match) return false;
  const hours = Number(match[2]);
  const minutes = Number(match[3]);
  return minutes <= 59 && (hours < 14 || (hours === 14 && minutes === 0));
}

function validateStoredTimezone(timezone: string): string {
  const cleaned = timezone.trim();
  if (isValidFixedOffsetTimezone(cleaned)) return cleaned;
  try {
    formatter(cleaned).format(new Date(0));
    return cleaned;
  } catch {
    throw new Error(
      `Invalid reminder due timezone '${cleaned}'. Use an IANA timezone such as Australia/Melbourne or a fixed offset such as UTC+10:00.`,
    );
  }
}

export function resolveReminderTimezone(explicit = process.env.JARVIS_TIMEZONE): string {
  const timezone = explicit?.trim() || Intl.DateTimeFormat().resolvedOptions().timeZone || "UTC";
  try {
    formatter(timezone).format(new Date(0));
    return timezone;
  } catch {
    throw new Error(
      `Invalid JARVIS_TIMEZONE '${timezone}'. Use an IANA timezone such as Australia/Melbourne.`,
    );
  }
}

function partsAt(timestamp: number, timezone: string): CalendarDateTime {
  const values = Object.fromEntries(
    formatter(timezone)
      .formatToParts(new Date(timestamp))
      .filter((part) => part.type !== "literal")
      .map((part) => [part.type, Number(part.value)]),
  ) as Record<string, number>;

  return {
    year: values.year,
    month: values.month,
    day: values.day,
    hour: values.hour,
    minute: values.minute,
    second: values.second,
  };
}

function equalCalendar(left: CalendarDateTime, right: CalendarDateTime): boolean {
  return (
    left.year === right.year &&
    left.month === right.month &&
    left.day === right.day &&
    left.hour === right.hour &&
    left.minute === right.minute &&
    left.second === right.second
  );
}

function utcTimestamp(value: CalendarDateTime, milliseconds = 0): number {
  const date = new Date(0);
  date.setUTCFullYear(value.year, value.month - 1, value.day);
  date.setUTCHours(value.hour, value.minute, value.second, milliseconds);
  return date.getTime();
}

function timezoneOffsetAt(timestamp: number, timezone: string): number {
  const rounded = Math.floor(timestamp / 1_000) * 1_000;
  const local = partsAt(rounded, timezone);
  return utcTimestamp(local) - rounded;
}

function isValidCalendar(value: CalendarDateTime): boolean {
  if (
    !Number.isInteger(value.year) ||
    !Number.isInteger(value.month) ||
    !Number.isInteger(value.day) ||
    !Number.isInteger(value.hour) ||
    !Number.isInteger(value.minute) ||
    !Number.isInteger(value.second) ||
    value.year < 0 ||
    value.year > 9_999 ||
    value.month < 1 ||
    value.month > 12 ||
    value.day < 1 ||
    value.day > 31 ||
    value.hour < 0 ||
    value.hour > 23 ||
    value.minute < 0 ||
    value.minute > 59 ||
    value.second < 0 ||
    value.second > 59
  ) {
    return false;
  }

  const check = new Date(utcTimestamp(value));
  return (
    check.getUTCFullYear() === value.year &&
    check.getUTCMonth() + 1 === value.month &&
    check.getUTCDate() === value.day &&
    check.getUTCHours() === value.hour &&
    check.getUTCMinutes() === value.minute &&
    check.getUTCSeconds() === value.second
  );
}

function zonedTimestamp(value: CalendarDateTime, timezone: string): number | undefined {
  if (!isValidCalendar(value)) return undefined;

  const wallClockUtc = utcTimestamp(value);
  const offsets = new Set<number>();
  for (const delta of [-2 * DAY_MS, -DAY_MS, 0, DAY_MS, 2 * DAY_MS]) {
    offsets.add(timezoneOffsetAt(wallClockUtc + delta, timezone));
  }

  const candidates = [...offsets]
    .map((offset) => wallClockUtc - offset)
    .filter((candidate) => equalCalendar(partsAt(candidate, timezone), value))
    .sort((left, right) => left - right);

  return candidates.length === 1 ? candidates[0] : undefined;
}

function parseTime(value: string): { hour: number; minute: number } | undefined {
  const trimmed = value.trim().toLowerCase();
  const match = /^(\d{1,2})(?::(\d{2}))?\s*(am|pm)?$/.exec(trimmed);
  if (!match) return undefined;
  if (match[2] === undefined && match[3] === undefined) return undefined;

  let hour = Number(match[1]);
  const minute = match[2] === undefined ? 0 : Number(match[2]);
  const meridiem = match[3];
  if (minute > 59) return undefined;

  if (meridiem !== undefined) {
    if (hour < 1 || hour > 12) return undefined;
    if (meridiem === "am") hour = hour === 12 ? 0 : hour;
    else hour = hour === 12 ? 12 : hour + 12;
  } else if (hour > 23) {
    return undefined;
  }

  return { hour, minute };
}

function addCalendarDays(value: CalendarDateTime, days: number): CalendarDateTime {
  const date = new Date(utcTimestamp({ ...value, day: value.day + days }));
  return {
    year: date.getUTCFullYear(),
    month: date.getUTCMonth() + 1,
    day: date.getUTCDate(),
    hour: value.hour,
    minute: value.minute,
    second: value.second,
  };
}

function withNormalized(raw: string, value: CalendarDateTime, timezone: string): ReminderDue {
  const at = zonedTimestamp(value, timezone);
  return at === undefined ? { raw } : { raw, at, timezone };
}

function parseAbsoluteIso(raw: string): ReminderDue | undefined {
  const match =
    /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2})(?::(\d{2})(?:\.(\d{1,3}))?)?(Z|([+-])(\d{2}):(\d{2}))$/i.exec(
      raw,
    );
  if (!match) return undefined;

  const value: CalendarDateTime = {
    year: Number(match[1]),
    month: Number(match[2]),
    day: Number(match[3]),
    hour: Number(match[4]),
    minute: Number(match[5]),
    second: match[6] === undefined ? 0 : Number(match[6]),
  };
  if (!isValidCalendar(value)) return { raw };

  const milliseconds = match[7] === undefined ? 0 : Number(match[7].padEnd(3, "0"));
  let offsetMinutes = 0;
  let timezone = "UTC";
  if (match[8].toUpperCase() !== "Z") {
    const offsetHours = Number(match[10]);
    const offsetMinutePart = Number(match[11]);
    if (offsetMinutePart > 59 || offsetHours > 14 || (offsetHours === 14 && offsetMinutePart > 0)) {
      return { raw };
    }
    const direction = match[9] === "+" ? 1 : -1;
    offsetMinutes = direction * (offsetHours * 60 + offsetMinutePart);
    timezone = `UTC${match[9]}${match[10]}:${match[11]}`;
  }

  const at = utcTimestamp(value, milliseconds) - offsetMinutes * 60_000;
  return Number.isFinite(at) ? { raw, at, timezone } : { raw };
}

export function parseReminderDue(
  input: string,
  options: { timezone?: string; now?: Date } = {},
): ReminderDue {
  const raw = input.trim();
  if (raw.length === 0) throw new Error("Reminder due text cannot be empty.");

  const absolute = parseAbsoluteIso(raw);
  if (absolute) return absolute;

  const timezone = resolveReminderTimezone(options.timezone);
  const now = options.now ?? new Date();
  if (Number.isNaN(now.getTime())) {
    throw new Error("Reminder parser received an invalid current time.");
  }
  const nowLocal = partsAt(now.getTime(), timezone);

  const isoLocal = /^(\d{4})-(\d{2})-(\d{2})(?:[ T](.+))?$/.exec(raw);
  if (isoLocal) {
    const time = isoLocal[4] === undefined ? { hour: 0, minute: 0 } : parseTime(isoLocal[4]);
    if (!time) return { raw };
    return withNormalized(
      raw,
      {
        year: Number(isoLocal[1]),
        month: Number(isoLocal[2]),
        day: Number(isoLocal[3]),
        hour: time.hour,
        minute: time.minute,
        second: 0,
      },
      timezone,
    );
  }

  const australian = /^(\d{1,2})\/(\d{1,2})\/(\d{4})(?:\s+(.+))?$/.exec(raw);
  if (australian) {
    const time = australian[4] === undefined ? { hour: 0, minute: 0 } : parseTime(australian[4]);
    if (!time) return { raw };
    return withNormalized(
      raw,
      {
        year: Number(australian[3]),
        month: Number(australian[2]),
        day: Number(australian[1]),
        hour: time.hour,
        minute: time.minute,
        second: 0,
      },
      timezone,
    );
  }

  const relative = /^(today|tomorrow)\s+(.+)$/i.exec(raw);
  if (relative) {
    const time = parseTime(relative[2]);
    if (!time) return { raw };
    const date = addCalendarDays(
      { ...nowLocal, hour: time.hour, minute: time.minute, second: 0 },
      relative[1].toLowerCase() === "tomorrow" ? 1 : 0,
    );
    return withNormalized(raw, date, timezone);
  }

  const weekday = /^(sunday|monday|tuesday|wednesday|thursday|friday|saturday)\s+(.+)$/i.exec(raw);
  if (weekday) {
    const time = parseTime(weekday[2]);
    if (!time) return { raw };
    const targetDay = WEEKDAYS.indexOf(weekday[1].toLowerCase() as (typeof WEEKDAYS)[number]);
    const currentDay = new Date(
      utcTimestamp({ ...nowLocal, hour: 0, minute: 0, second: 0 }),
    ).getUTCDay();
    let daysAhead = (targetDay - currentDay + 7) % 7;
    let candidate = addCalendarDays(
      { ...nowLocal, hour: time.hour, minute: time.minute, second: 0 },
      daysAhead,
    );
    let at = zonedTimestamp(candidate, timezone);
    if (at !== undefined && at <= now.getTime()) {
      daysAhead += 7;
      candidate = addCalendarDays(
        { ...nowLocal, hour: time.hour, minute: time.minute, second: 0 },
        daysAhead,
      );
      at = zonedTimestamp(candidate, timezone);
    }
    return at === undefined ? { raw } : { raw, at, timezone };
  }

  return { raw };
}

export function validateReminderDue(due: ReminderDue): ReminderDue {
  const raw = due.raw.trim();
  if (raw.length === 0) throw new Error("Reminder due text cannot be empty.");
  const hasAt = due.at !== undefined;
  const hasTimezone = due.timezone !== undefined;
  if (hasAt !== hasTimezone) {
    throw new Error("A normalized reminder due value requires both a timestamp and timezone.");
  }
  if (due.at !== undefined && !Number.isFinite(due.at)) {
    throw new Error("Reminder due timestamp must be a finite number.");
  }

  const timezone = due.timezone === undefined ? undefined : validateStoredTimezone(due.timezone);
  return {
    raw,
    ...(due.at === undefined ? {} : { at: due.at, timezone: timezone as string }),
  };
}
