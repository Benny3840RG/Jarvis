/**
 * NOLAN voice — small talk ("thanks mate", "g'day").
 *
 * Matched only against fixed whole phrases, answered with a fixed reply, and
 * never handed to the conversation model: it reads nothing and does nothing.
 */

import { rundownMatchKey } from "./voiceRundown.js";

const THANKS = new Set([
  "thanks",
  "thank you",
  "thanks mate",
  "thank you mate",
  "thanks nolan",
  "thank you nolan",
  "cheers",
  "cheers mate",
  "ta",
  "ta mate",
  "legend",
  "good on ya",
  "good stuff",
  "nice one",
  "perfect",
  "awesome",
  "beauty",
  "sweet",
]);

const GREETINGS = new Set([
  "hi",
  "hey",
  "hello",
  "gday",
  "gday mate",
  "hey mate",
  "hi mate",
  "hello mate",
  "morning",
  "good morning",
  "afternoon",
  "good afternoon",
  "evening",
  "good evening",
  "you there",
  "are you there",
  "hows it going",
  "how are you",
  "how ya going",
  "how are ya",
]);

const GOODBYES = new Set([
  "thats all",
  "thats it",
  "thats all thanks",
  "thats it thanks",
  "all good",
  "all good thanks",
  "no thats all",
  "nah thats it",
  "bye",
  "see ya",
  "later",
  "catch ya",
  "night",
  "good night",
]);

const TIME = new Set([
  "time",
  "the time",
  "what time is it",
  "whats the time",
  "what is the time",
  "whats the time now",
  "what time is it now",
  "got the time",
  "have you got the time",
]);

const DATE = new Set([
  "what day is it",
  "what day is it today",
  "whats the date",
  "what is the date",
  "whats the date today",
  "what is the date today",
  "whats todays date",
  "what is todays date",
  "whats today",
]);

const HELP = new Set([
  "help",
  "help me",
  "what can you do",
  "what can you do for me",
  "what do you do",
  "what can i say",
  "what can i ask",
  "what can i ask you",
  "how do i use you",
  "how does this work",
]);

export const VOICE_HELP_REPLY =
  "I can add tasks, reminders and errands, tick them off, and tell you what's on. " +
  "Try “remind me to call Dave tomorrow at 9 am”, “add milk to the shopping list” " +
  "or “give me the rundown”. If I get one wrong, just say “undo”.";

export type SmallTalkClock = Readonly<{ now: number; timezone: string }>;

function clockReply(kind: "time" | "date", clock: SmallTalkClock): string | undefined {
  try {
    if (kind === "date") {
      const date = new Intl.DateTimeFormat("en-AU", {
        timeZone: clock.timezone,
        weekday: "long",
        day: "numeric",
        month: "long",
      })
        .format(new Date(clock.now))
        .replace(",", "");
      return `It's ${date}.`;
    }
    const parts = new Intl.DateTimeFormat("en-AU", {
      timeZone: clock.timezone,
      hour: "numeric",
      minute: "2-digit",
      hour12: true,
    }).formatToParts(new Date(clock.now));
    const get = (type: string) => parts.find((part) => part.type === type)?.value ?? "";
    const period = get("dayPeriod").toLowerCase().replace(/\./g, "");
    return `It's ${get("hour")}:${get("minute")} ${period}.`;
  } catch {
    return undefined;
  }
}

/**
 * A fixed friendly reply for a whole small-talk phrase, else undefined. The
 * time and date come from the server clock in the owner's timezone; without a
 * clock those phrases are not answered here.
 */
export function smallTalkReply(transcript: string, clock?: SmallTalkClock): string | undefined {
  const key = rundownMatchKey(transcript.replace(/\bnolan\b[,!.?]?\s*$/i, "").trim());
  if (HELP.has(key)) return VOICE_HELP_REPLY;
  if (clock && TIME.has(key)) return clockReply("time", clock);
  if (clock && DATE.has(key)) return clockReply("date", clock);
  if (THANKS.has(key)) return "No worries.";
  if (GREETINGS.has(key)) return "G'day. What can I do for you?";
  if (GOODBYES.has(key)) return "No worries. Catch you later.";
  return undefined;
}
