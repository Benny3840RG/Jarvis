/**
 * NOLAN voice — the spoken daily rundown ("Nolan, give me the rundown").
 *
 * A read-only query that is not a catalog phrase (the archived catalog is
 * pinned). It is matched only against a fixed set of whole phrases, never
 * fuzzily, and is answered by the same authoritative query provider as every
 * other voice query. It never writes, stages, approves or executes.
 *
 * "what is on today" stays the catalog's jobs-only schedule query; the
 * rundown phrases are deliberately distinct from it.
 */

import type { VoiceCommand, VoiceProfile } from "./voiceCommands.js";

export const DAILY_RUNDOWN_COMMAND_ID = "client.daily-rundown";

export const DAILY_RUNDOWN_COMMAND: VoiceCommand = Object.freeze({
  id: DAILY_RUNDOWN_COMMAND_ID,
  profile: "client" as const,
  phrases: Object.freeze([]) as readonly string[],
  kind: "query" as const,
  criticality: "routine" as const,
  requiresSpokenConfirmation: false,
  summary:
    "Read today's rundown: jobs booked today, reminders due or coming up, open tasks and open errands.",
});

export const TOMORROW_RUNDOWN_COMMAND_ID = "client.tomorrow-rundown";

export const TOMORROW_RUNDOWN_COMMAND: VoiceCommand = Object.freeze({
  id: TOMORROW_RUNDOWN_COMMAND_ID,
  profile: "client" as const,
  phrases: Object.freeze([]) as readonly string[],
  kind: "query" as const,
  criticality: "routine" as const,
  requiresSpokenConfirmation: false,
  summary: "Read tomorrow: jobs booked for tomorrow and reminders due tomorrow.",
});

const TOMORROW_PHRASES: ReadonlySet<string> = new Set([
  "tomorrow",
  "whats on tomorrow",
  "what is on tomorrow",
  "whats happening tomorrow",
  "what is happening tomorrow",
  "what have i got on tomorrow",
  "what have i got tomorrow",
  "what have i got on for tomorrow",
  "what do i have tomorrow",
  "what do i have on tomorrow",
  "whats tomorrow look like",
  "what does tomorrow look like",
  "whats tomorrow looking like",
  "hows tomorrow looking",
  "how is tomorrow looking",
  "how does tomorrow look",
  "give me tomorrows rundown",
  "tomorrows rundown",
  "run me through tomorrow",
  "anything on tomorrow",
  "am i busy tomorrow",
]);

const RUNDOWN_PHRASES: ReadonlySet<string> = new Set([
  "rundown",
  "the rundown",
  "my rundown",
  "daily rundown",
  "the daily rundown",
  "my daily rundown",
  "give me the rundown",
  "give me my rundown",
  "give me a rundown",
  "give me the daily rundown",
  "give me my daily rundown",
  "run me through today",
  "run me through my day",
  "brief me",
  "daily brief",
  "my daily brief",
  "morning brief",
  "my morning brief",
  "what does my day look like",
  "whats my day look like",
  "whats my day looking like",
  "hows my day looking",
  "how does my day look",
  "what have i got on today",
  "what have i got today",
  "how is my day looking",
  "how is my day",
  "hows my day",
  "how does today look",
  "hows today looking",
  "how is today looking",
  "whats my day like",
  "what is my day like",
  "what does today look like",
  "what have i got on",
  "whats happening today",
  "what is happening today",
]);

/** Lower-case words only: apostrophes dropped, other punctuation a space, "please" trimmed. */
export function rundownMatchKey(transcript: string): string {
  return transcript
    .toLowerCase()
    .replace(/['’‘`]/g, "")
    .replace(/[^\p{L}\p{N}]+/gu, " ")
    .trim()
    .replace(/^(?:please )+|(?: please)+$/g, "")
    .trim();
}

/** The today or tomorrow rundown for an exact phrase on the client profile, else undefined. */
export function matchVoiceRundown(
  transcript: string,
  profile: VoiceProfile,
): VoiceCommand | undefined {
  if (profile !== "client") return undefined;
  const key = rundownMatchKey(transcript);
  if (RUNDOWN_PHRASES.has(key)) return DAILY_RUNDOWN_COMMAND;
  return TOMORROW_PHRASES.has(key) ? TOMORROW_RUNDOWN_COMMAND : undefined;
}
